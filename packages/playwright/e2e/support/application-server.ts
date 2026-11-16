import { createServer, type Server } from 'node:http';

export const applicationServiceUuid = '12345678-1234-5678-9abc-def123456b00';
export const applicationCharacteristicUuid =
  '12345678-1234-5678-9abc-def123456b01';
export const duplicateNameServiceUuid = '12345678-1234-5678-9abc-def123456b10';
export const duplicateNameCharacteristicUuid =
  '12345678-1234-5678-9abc-def123456b11';

const applicationHtml = `<!doctype html>
<html lang="en">
  <meta charset="utf-8">
  <title>GattLab Playwright fixture contract</title>
  <body>
    <button id="choose" type="button">Choose fixture sensor</button>
    <button id="connect" type="button">Connect and read fixture sensor</button>
    <button id="connect-duplicate" type="button">Connect duplicate sensor</button>
    <output data-testid="battery">--</output>
    <output data-testid="duplicate-name">--</output>
    <output data-testid="duplicate-value">--</output>
    <script>
      window.fixtureState = { outcome: 'idle' };
      window.requestsStarted = 0;
      document.querySelector('#choose').onclick = async () => {
        window.fixtureState = { outcome: 'pending' };
        try {
          const request = navigator.bluetooth.requestDevice({
            filters: [{ services: ['${applicationServiceUuid}'] }],
          });
          window.requestsStarted += 1;
          await request;
          window.fixtureState = { outcome: 'selected' };
        } catch (error) {
          window.fixtureState = {
            outcome: 'cancelled',
            errorName: error.name,
          };
        }
      };
      document.querySelector('#connect').onclick = async () => {
        window.fixtureState = { outcome: 'pending' };
        try {
          const device = await navigator.bluetooth.requestDevice({
            filters: [{ services: ['${applicationServiceUuid}'] }],
          });
          const server = await device.gatt.connect();
          const service = await server.getPrimaryService('${applicationServiceUuid}');
          const characteristic = await service.getCharacteristic('${applicationCharacteristicUuid}');
          const value = await characteristic.readValue();
          const battery = value.getUint8(0);
          document.querySelector('[data-testid="battery"]').textContent = battery + '%';
          window.fixtureState = { outcome: 'read', battery };
        } catch (error) {
          window.fixtureState = {
            outcome: 'failed',
            errorName: error.name,
          };
        }
      };
      document.querySelector('#connect-duplicate').onclick = async () => {
        window.fixtureState = { outcome: 'pending' };
        try {
          const device = await navigator.bluetooth.requestDevice({
            filters: [{ services: ['${applicationServiceUuid}'] }],
            optionalServices: ['${duplicateNameServiceUuid}'],
          });
          const server = await device.gatt.connect();
          const service = await server.getPrimaryService('${duplicateNameServiceUuid}');
          const characteristic = await service.getCharacteristic('${duplicateNameCharacteristicUuid}');
          const value = (await characteristic.readValue()).getUint8(0);
          document.querySelector('[data-testid="duplicate-name"]').textContent = device.name;
          document.querySelector('[data-testid="duplicate-value"]').textContent = String(value);
          window.fixtureState = {
            outcome: 'read',
            battery: value,
            deviceName: device.name,
          };
        } catch (error) {
          window.fixtureState = {
            outcome: 'failed',
            errorName: error.name,
          };
        }
      };
    </script>
  </body>
</html>`;

export interface ApplicationServer {
  readonly server: Server;
  readonly url: string;
}

export function startApplicationServer(): Promise<ApplicationServer> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(applicationHtml);
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new TypeError('Expected a TCP application-server address.'));
        return;
      }
      resolve({
        server,
        url: `http://127.0.0.1:${String(address.port)}`,
      });
    });
  });
}

export function stopApplicationServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((cause) => {
      if (cause === undefined) resolve();
      else reject(cause);
    });
  });
}
