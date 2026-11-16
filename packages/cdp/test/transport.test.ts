import { describe, expect, expectTypeOf, it, vi } from 'vitest';

import {
  CdpTransportError,
  createCdpTransport,
  type CdpSessionLike,
} from '../src/index.js';

interface SentCommand {
  readonly method: string;
  readonly parameters?: object;
}

class FakeCdpSession implements CdpSessionLike {
  readonly calls: SentCommand[] = [];
  readonly listeners = new Map<string, Set<(payload: unknown) => void>>();
  readonly responses = new Map<string, unknown>();
  failure: unknown;
  detachCount = 0;

  async send(method: string, parameters?: object): Promise<unknown> {
    this.calls.push({
      method,
      ...(parameters === undefined ? {} : { parameters }),
    });
    if (this.failure !== undefined) throw this.failure;
    return this.responses.get(method);
  }

  on(event: string, listener: (payload: unknown) => void): void {
    const listeners = this.listeners.get(event) ?? new Set();
    listeners.add(listener);
    this.listeners.set(event, listeners);
  }

  off(event: string, listener: (payload: unknown) => void): void {
    this.listeners.get(event)?.delete(listener);
  }

  async detach(): Promise<void> {
    this.detachCount += 1;
  }

  emit(event: string, payload: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) listener(payload);
  }
}

describe('CdpTransport', () => {
  it('reads browser identity only through the browser transport', async () => {
    const session = new FakeCdpSession();
    session.responses.set('Browser.getVersion', {
      protocolVersion: '1.3',
      product: 'HeadlessChrome/151.0.7922.34',
      revision: '@revision',
      userAgent: 'HeadlessChrome',
      jsVersion: '15.1',
    });
    const transport = createCdpTransport('browser', session);

    const result = await transport.send('Browser.getVersion');

    expect(result.product).toBe('HeadlessChrome/151.0.7922.34');
    expectTypeOf(result.product).toBeString();
    expect(session.calls).toEqual([{ method: 'Browser.getVersion' }]);
  });

  it('sends target-specific typed commands and returns mapped results', async () => {
    const session = new FakeCdpSession();
    session.responses.set('BluetoothEmulation.addService', {
      serviceId: 'service-1',
    });
    const transport = createCdpTransport('browser', session);

    const result = await transport.send('BluetoothEmulation.addService', {
      address: '00:11:22:33:44:55',
      serviceUuid: '0000180f-0000-1000-8000-00805f9b34fb',
    });

    expect(result).toEqual({ serviceId: 'service-1' });
    expectTypeOf(result).toEqualTypeOf<{ serviceId: string }>();
    expect(session.calls).toEqual([
      {
        method: 'BluetoothEmulation.addService',
        parameters: {
          address: '00:11:22:33:44:55',
          serviceUuid: '0000180f-0000-1000-8000-00805f9b34fb',
        },
      },
    ]);
  });

  it('rejects a target mismatch before mutating the raw session', async () => {
    const session = new FakeCdpSession();
    const transport = createCdpTransport('browser', session);

    await expect(
      transport.send('DeviceAccess.enable' as never),
    ).rejects.toThrow(TypeError);
    expect(session.calls).toEqual([]);
  });

  it('types event payloads and removes listeners idempotently', () => {
    const session = new FakeCdpSession();
    const transport = createCdpTransport('browser', session);
    const listener = vi.fn();
    const unsubscribe = transport.on(
      'BluetoothEmulation.gattOperationReceived',
      (event) => {
        expectTypeOf(event).toEqualTypeOf<{
          address: string;
          type: 'connection' | 'discovery';
        }>();
        listener(event.address, event.type);
      },
    );

    session.emit('BluetoothEmulation.gattOperationReceived', {
      address: '00:11:22:33:44:55',
      type: 'connection',
    });
    unsubscribe();
    unsubscribe();
    session.emit('BluetoothEmulation.gattOperationReceived', {
      address: 'AA:BB:CC:DD:EE:FF',
      type: 'discovery',
    });

    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith('00:11:22:33:44:55', 'connection');
  });

  it('preserves command failures without classifying message text', async () => {
    const session = new FakeCdpSession();
    const cause = new Error("method wasn't found");
    session.failure = cause;
    const transport = createCdpTransport('page', session);

    const failure = transport
      .send('DeviceAccess.enable')
      .catch((error: unknown) => error);

    await expect(failure).resolves.toMatchObject({
      name: 'CdpTransportError',
      kind: 'command-failed',
      target: 'page',
      method: 'DeviceAccess.enable',
      cause,
    });
  });

  it('classifies closure from session state and makes detach idempotent', async () => {
    const session = new FakeCdpSession();
    const transport = createCdpTransport('page', session);
    const unsubscribe = transport.on(
      'DeviceAccess.deviceRequestPrompted',
      vi.fn(),
    );
    expect(
      session.listeners.get('DeviceAccess.deviceRequestPrompted')?.size,
    ).toBe(1);

    session.emit('close', undefined);

    expect(transport.closed).toBe(true);
    expect(
      session.listeners.get('DeviceAccess.deviceRequestPrompted')?.size,
    ).toBe(0);
    expect(unsubscribe).not.toThrow();
    await expect(transport.send('DeviceAccess.enable')).rejects.toMatchObject({
      name: 'CdpTransportError',
      kind: 'session-closed',
    } satisfies Partial<CdpTransportError>);

    await Promise.all([transport.detach(), transport.detach()]);
    expect(session.detachCount).toBe(1);
  });

  it('classifies an in-flight rejection after the session closes', async () => {
    const session = new FakeCdpSession();
    let rejectCommand: ((cause: unknown) => void) | undefined;
    session.responses.set(
      'DeviceAccess.enable',
      new Promise<never>((_resolve, reject) => {
        rejectCommand = reject;
      }),
    );
    const transport = createCdpTransport('page', session);
    const command = transport.send('DeviceAccess.enable');

    session.emit('close', undefined);
    rejectCommand?.(new Error('connection ended'));

    await expect(command).rejects.toMatchObject({
      name: 'CdpTransportError',
      kind: 'session-closed',
    } satisfies Partial<CdpTransportError>);
  });
});
