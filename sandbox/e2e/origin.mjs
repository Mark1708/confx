const configuredPort = process.env.SANDBOX_E2E_PORT ?? "4177";
if (!/^[1-9]\d*$/.test(configuredPort) || Number(configuredPort) > 65535)
  throw new Error("SANDBOX_E2E_PORT must be a TCP port from 1 to 65535");

export const LOCAL_PORT = String(Number(configuredPort));
export const LOCAL_ORIGIN = `http://127.0.0.1:${LOCAL_PORT}`;
