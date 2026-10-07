// Fetches and unpacks vegetation regions off the main thread: the page gets each chunk ready
// for the GPU (see vegpack.js), so a big region arriving never stalls a drag or a zoom.
import { unpackRegion } from './vegpack.js';

self.onmessage = async (e) => {
  const { id, url } = e.data;
  try {
    const r = await fetch(url, { cache: 'default' });
    if (!r.ok) throw new Error(`${url}: ${r.status}`);
    const chunks = unpackRegion(await r.arrayBuffer());
    self.postMessage({ id, chunks }, chunks.flatMap((c) => [c.bytes, c.lodBytes]));
  } catch (err) {
    self.postMessage({ id, error: String(err) });
  }
};
