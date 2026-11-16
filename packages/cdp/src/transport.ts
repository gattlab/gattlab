import type { ProtocolMapping } from 'devtools-protocol/types/protocol-mapping.js';

export type CdpTarget = 'browser' | 'page';

type BrowserCdpCommand = Extract<
  keyof ProtocolMapping.Commands,
  `BluetoothEmulation.${string}` | 'Browser.getVersion'
>;

type PageCdpCommand = Extract<
  keyof ProtocolMapping.Commands,
  `DeviceAccess.${string}`
>;

export type BluetoothCdpCommand<Target extends CdpTarget> =
  Target extends 'browser' ? BrowserCdpCommand : PageCdpCommand;

type CdpEventDomain<Target extends CdpTarget> = Target extends 'browser'
  ? 'BluetoothEmulation'
  : 'DeviceAccess';

export type BluetoothCdpEvent<Target extends CdpTarget> = Extract<
  keyof ProtocolMapping.Events,
  `${CdpEventDomain<Target>}.${string}`
>;

export type CdpCommandArguments<Method extends BluetoothCdpCommand<CdpTarget>> =
  ProtocolMapping.Commands[Method]['paramsType'];

export type CdpCommandResult<Method extends BluetoothCdpCommand<CdpTarget>> =
  ProtocolMapping.Commands[Method]['returnType'];

export type CdpEventPayload<Event extends BluetoothCdpEvent<CdpTarget>> =
  ProtocolMapping.Events[Event][0];

/** The structural subset of Playwright CDPSession consumed by this package. */
export interface CdpSessionLike {
  /** Send a raw session command; the session owns rejection and deadline behavior. */
  send(method: string, parameters?: object): Promise<unknown>;
  /** Register a raw event listener synchronously; return value is ignored. */
  on(event: string, listener: (payload: unknown) => void): unknown;
  /** Remove the exact raw listener synchronously; return value is ignored. */
  off(event: string, listener: (payload: unknown) => void): unknown;
  /** Detach this underlying session; the session owns completion and failures. */
  detach(): Promise<void>;
}

export type CdpTransportErrorKind = 'command-failed' | 'session-closed';

/** Wraps a failed or closed-session CDP command with target metadata. */
export class CdpTransportError extends Error {
  readonly kind: CdpTransportErrorKind;
  readonly target: CdpTarget;
  readonly method: string;

  /** Preserve command/target/kind metadata and optional cause; this Error has no GattLab domain code. */
  constructor(options: {
    kind: CdpTransportErrorKind;
    target: CdpTarget;
    method: string;
    cause?: unknown;
  }) {
    super(`CDP ${options.method} failed on the ${options.target} session.`, {
      ...('cause' in options ? { cause: options.cause } : {}),
    });
    this.name = 'CdpTransportError';
    this.kind = options.kind;
    this.target = options.target;
    this.method = options.method;
  }
}

interface CdpSubscription {
  readonly event: string;
  readonly listener: (payload: unknown) => void;
}

/** Restricts commands and events to the CDP domain of one session target. */
export class CdpTransport<Target extends CdpTarget> {
  readonly target: Target;
  readonly #session: CdpSessionLike;
  readonly #subscriptions = new Set<CdpSubscription>();
  readonly #closeListener: (payload: unknown) => void;
  #closed = false;
  #detachPromise: Promise<void> | undefined;

  /** Wrap one session and register its close listener; the wrapper adds no command deadline or browser-process lease. */
  constructor(target: Target, session: CdpSessionLike) {
    this.target = target;
    this.#session = session;
    this.#closeListener = () => {
      this.#closed = true;
      this.#removeSubscriptions();
    };
    session.on('close', this.#closeListener);
  }

  /** Whether session closure or completed detachment has been observed. */
  get closed(): boolean {
    return this.#closed;
  }

  /** Send a target-typed request; wrong target rejects with TypeError, command/closure failures with CdpTransportError. No wrapper deadline. */
  async send<Method extends BluetoothCdpCommand<Target>>(
    method: Method,
    ...parameters: CdpCommandArguments<Method>
  ): Promise<CdpCommandResult<Method>> {
    this.#assertTargetMethod(method);
    if (this.#closed) {
      throw new CdpTransportError({
        kind: 'session-closed',
        target: this.target,
        method,
      });
    }

    try {
      const [request] = parameters;
      const result =
        request === undefined
          ? await this.#session.send(method)
          : await this.#session.send(method, request);
      return result as CdpCommandResult<Method>;
    } catch (cause) {
      throw new CdpTransportError({
        kind: this.#currentErrorKind(),
        target: this.target,
        method,
        cause,
      });
    }
  }

  /** Subscribe to a target-typed event and return idempotent unsubscribe; wrong target/closed session throws synchronously. Listener exceptions propagate. */
  on<Event extends BluetoothCdpEvent<Target>>(
    event: Event,
    listener: (payload: CdpEventPayload<Event>) => void,
  ): () => void {
    this.#assertTargetMethod(event);
    if (this.#closed) {
      throw new CdpTransportError({
        kind: 'session-closed',
        target: this.target,
        method: event,
      });
    }

    const rawListener = (payload: unknown): void => {
      listener(payload as CdpEventPayload<Event>);
    };
    const subscription: CdpSubscription = { event, listener: rawListener };
    this.#subscriptions.add(subscription);
    this.#session.on(event, rawListener);

    return () => {
      if (!this.#subscriptions.delete(subscription)) return;
      this.#session.off(event, rawListener);
    };
  }

  /** Remove subscriptions and detach once; repeated calls share the promise and underlying detach failure is preserved. No deadline. */
  detach(): Promise<void> {
    this.#detachPromise ??= this.#detach();
    return this.#detachPromise;
  }

  async #detach(): Promise<void> {
    this.#removeSubscriptions();
    this.#session.off('close', this.#closeListener);

    try {
      await this.#session.detach();
    } finally {
      this.#closed = true;
    }
  }

  #removeSubscriptions(): void {
    for (const { event, listener } of this.#subscriptions) {
      this.#session.off(event, listener);
    }
    this.#subscriptions.clear();
  }

  #assertTargetMethod(method: string): void {
    const isAllowed =
      this.target === 'browser'
        ? method === 'Browser.getVersion' ||
          method.startsWith('BluetoothEmulation.')
        : method.startsWith('DeviceAccess.');
    if (!isAllowed) {
      throw new TypeError(
        `${method} cannot be sent through the ${this.target} CDP transport.`,
      );
    }
  }

  #currentErrorKind(): CdpTransportErrorKind {
    return this.#closed ? 'session-closed' : 'command-failed';
  }
}

/** Creates a target-restricted transport around a Playwright CDP session. */
export function createCdpTransport<Target extends CdpTarget>(
  target: Target,
  session: CdpSessionLike,
): CdpTransport<Target> {
  return new CdpTransport(target, session);
}
