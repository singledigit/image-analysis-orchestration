const ENDPOINT = process.env.REALTIME_ENDPOINT!;  // https://<domain>/event
const API_KEY  = process.env.REALTIME_API_KEY!;

// Never throws — pipeline must not fail due to observability side-effects.
export async function publish(channel: string, events: unknown[]): Promise<void> {
  if (!ENDPOINT || !API_KEY) return;
  try {
    const body = JSON.stringify({
      channel,
      events: events.map(e => JSON.stringify(e)),  // AppSync expects array of JSON strings
    });

    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': API_KEY,
      },
      body,
    });

    if (!res.ok) {
      const text = await res.text();
      console.warn(`[events] publish ${res.status}:`, text.slice(0, 200));
    }
  } catch (err) {
    console.warn('[events] publish failed (non-fatal):', err);
  }
}
