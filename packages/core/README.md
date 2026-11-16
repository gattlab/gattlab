# `@gattlab/core`

Protocol-independent Bluetooth domain contracts for GattLab. This package owns
normalized values, validated virtual-peripheral definitions, stable errors, the
automation-backend boundary, and bounded diagnostic timelines. It does not
depend on Playwright, CDP, browser globals, Node filesystem APIs, or wall-clock
time.

The package is published on npm as a prerelease under the `beta` tag. Most
tests need only `@gattlab/playwright`, which depends on it and re-exports
`bytes`. Import only from `@gattlab/core`; internal module paths are not public
API.

See the [quick start](https://github.com/gattlab/gattlab/blob/main/docs/quick-start.md),
[API semantics](https://github.com/gattlab/gattlab/blob/main/docs/api.md), [troubleshooting](https://github.com/gattlab/gattlab/blob/main/docs/troubleshooting.md)
and [compatibility](https://github.com/gattlab/gattlab/blob/main/docs/compatibility.md). The production backend is
experimental Chromium CDP with one active adapter owner per process. Notification
payloads cannot be injected. See the
[document-destruction limitation](https://github.com/gattlab/gattlab/blob/main/docs/protocol-limitations.md#document-destruction-and-process-reuse).

## Define and validate a peripheral

```ts
import {
  bytes,
  validatePeripheralDefinition,
  type NormalizedPeripheral,
  type PeripheralDefinition,
} from '@gattlab/core';

const definition = {
  address: '00:11:22:33:44:55',
  name: 'Battery sensor',
  advertisement: { rssi: -45 },
  services: [
    {
      uuid: '180f',
      characteristics: [
        {
          uuid: '2a19',
          properties: ['read', 'write', 'notify'],
          initialValue: bytes([87]),
          descriptors: [{ uuid: '2902' }],
        },
      ],
    },
  ],
} satisfies PeripheralDefinition;

const result = validatePeripheralDefinition(definition);
if (!result.success) {
  throw new Error(JSON.stringify(result.issues));
}

const peripheral: NormalizedPeripheral = result.value;
```

Validation returns every path-aware issue it can observe. Successful output is
normalized and immutable. Byte inputs are defensively copied; byte-valued
properties return fresh `Uint8Array` values.

A characteristic with `notify` or `indicate` must explicitly define the Client
Characteristic Configuration descriptor (`0x2902`). Validation reports
`missing-cccd-descriptor` at that characteristic's `descriptors` path instead
of allowing Chromium to reject `startNotifications()` later without emitting a
characteristic-operation event.

## Public API map

- Primitives: `normalizeBluetoothUuid`, `normalizeBluetoothAddress`, and the
  callable `bytes` factory with `hex`, `base64`, `text`, and `uint16le` helpers.
- Device model: `validatePeripheralDefinition`, input definitions, normalized
  hierarchy types, characteristic properties, and validation results.
- Errors: closed `GattLabError` codes, concrete Bluetooth errors, immutable
  diagnostic context, the chooser-specific `PromptDeviceNotFoundError`, and
  stable scripting-side ATT/HCI error names.
- Backend contract: structural cancellation, immutable capabilities, stable
  entity references, discriminated operation events/responses, transactional
  address registration, lifecycle control, and ordered best-effort cleanup.
- Timeline: `createBluetoothTimeline`, explicit monotonic/elapsed timing,
  bounded newest-event retention, immutable snapshots, and stable categories
  and statuses.

`PromptDeviceNotFoundError` distinguishes a chooser that does not contain the
requested virtual peripheral from transport failure or user cancellation. Its
diagnostic context is immutable and identifies address-based versus explicit
id-based selection without copying the complete prompt payload:

```ts
import { PromptDeviceNotFoundError } from '@gattlab/core';
import type { DevicePrompt, PeripheralHandle } from '@gattlab/playwright';

export async function selectPeripheral(
  prompt: DevicePrompt,
  peripheral: PeripheralHandle,
) {
  try {
    await prompt.select(peripheral);
  } catch (error) {
    if (error instanceof PromptDeviceNotFoundError) {
      console.error(error.code, error.context['selectionMode']);
    }
    throw error;
  }
}
```

`BluetoothLabAlreadyActiveError` distinguishes two process-wide ownership
checks. `context.detection` is `in-process-lease` when another fixture in the
same Playwright client already owns the browser, or `cdp-domain-conflict` when
a different client reached the same Chromium process through `connectOptions`
or a shared browser server. Both carry `leaseScope: 'browser-process'` and
`remediation: 'use-separate-browser-process'`; the CDP-detected variant keeps
the transport failure as its `cause`.

## Timeline lifecycle

`createBluetoothTimeline` requires a positive safe-integer limit and an
injected monotonic clock. The clock keeps core deterministic and independent of
environment time APIs.

During teardown, append cleanup failures and late completions first, take any
required artifact snapshot, and call `close()` last. Closing is idempotent;
later appends throw `BluetoothBackendStoppedError` so diagnostics cannot be
silently lost.

## Contract boundaries

- Backend operations expose domain references and synthetic `operationId`
  values, never transport identifiers.
- Capability snapshots distinguish general service construction from secondary
  service support. The Chromium CDP backend reports `secondaryServices: false`
  because its service command cannot encode the primary/secondary distinction.
- An `operationId` is valid only for one pending operation in one backend
  instance and expires after settlement or stop.
- Event listeners receive separate frozen envelopes. Write payloads are fresh
  `Uint8Array` instances owned by each listener.
- Characteristic write events distinguish deprecated `writeValue()` as
  `default-deprecated`, `writeValueWithResponse()` as `with-response`, and
  `writeValueWithoutResponse()` as `without-response`.
- Injected ATT/HCI names are scripting inputs. Native Web Bluetooth failures
  may surface only as generic application exceptions; the mapping is one-way.

See [protocol limitations](https://github.com/gattlab/gattlab/blob/main/docs/protocol-limitations.md) and the
[public API reference](https://github.com/gattlab/gattlab/blob/main/docs/api.md#normalize-bytes-and-models) for model
validation and the boundary between domain values and browser behavior.

## License

[Apache-2.0](https://github.com/gattlab/gattlab/blob/main/LICENSE).
