const original = globalThis.fetch;
globalThis.fetch = (input, options) => {
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) return Promise.reject(new Error("Worker fixture refuses non-loopback HTTP"));
  return original(input, options);
};
