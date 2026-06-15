import React, { useState } from 'react';
// Uses the literal '/api/bypass/test' path: constants/api.ts only exports API_ENDPOINTS
// (no API_BASE), and the viewer is served same-origin by the worker, so a relative
// path is correct. To centralize, add API_ENDPOINTS.BYPASS_TEST and import it instead.

export function BypassTestButton({ baseUrl, apiKey, model }: { baseUrl: string; apiKey: string; model: string }) {
  const [status, setStatus] = useState<'idle' | 'testing' | 'ok' | 'fail'>('idle');
  const [msg, setMsg] = useState('');
  const run = async () => {
    setStatus('testing'); setMsg('');
    try {
      const res = await fetch('/api/bypass/test', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ baseUrl, apiKey, model }),
      });
      const data = await res.json();
      if (data.ok) { setStatus('ok'); setMsg('Connected'); }
      else { setStatus('fail'); setMsg(`${data.status ?? ''} ${data.message ?? 'failed'}`.trim()); }
    } catch (e) {
      setStatus('fail'); setMsg(e instanceof Error ? e.message : 'request failed');
    }
  };
  return (
    <div style={{ marginTop: '8px' }}>
      <button type="button" onClick={run} disabled={status === 'testing' || !baseUrl || !apiKey || !model}>
        {status === 'testing' ? 'Testing…' : 'Test connection'}
      </button>
      {status === 'ok' && <span style={{ color: 'var(--success, #2ea043)', marginLeft: 8 }}>✅ {msg}</span>}
      {status === 'fail' && <span style={{ color: 'var(--error, #cf222e)', marginLeft: 8 }}>❌ {msg}</span>}
    </div>
  );
}
