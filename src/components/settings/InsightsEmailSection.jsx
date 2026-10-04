import { useState, useEffect, useCallback } from 'react';
import { Mail, Send, CheckCircle2, AlertTriangle, Clock, Pause, Play } from 'lucide-react';
import { api } from '@/lib/api';
import { Btn, SectionCard, TextInput, Badge } from '@/components/ui/CognosUi';

function formatRunTime(ms) {
  if (!ms) return '—';
  return new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export default function InsightsEmailSection() {
  const [status, setStatus] = useState(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [sendTime, setSendTime] = useState('07:00');
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(null); // 'save' | 'test' | 'run' | 'schedule' | 'clearPw'
  const [message, setMessage] = useState(null); // { ok, text }

  const refresh = useCallback(async () => {
    try {
      const data = await api.insightsEmailStatus();
      setStatus(data);
      setEmail(data.email_address || '');
      setSendTime(data.send_time || '07:00');
      setEnabled(data.enabled === true);
      setPassword('');
    } catch (e) {
      setMessage({ ok: false, text: e.message || 'Could not load email settings.' });
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const runOp = async (kind, fn, okText) => {
    setBusy(kind); setMessage(null);
    try {
      const result = await fn();
      setMessage({ ok: true, text: okText || result?.message || 'Done.' });
      await refresh();
    } catch (e) {
      setMessage({ ok: false, text: e.message || 'Something went wrong.' });
    } finally {
      setBusy(null);
    }
  };

  const saveCredentials = () => runOp('save',
    () => api.insightsEmailSave({ email_address: email, app_password: password }),
    'Email saved. Send a test email to make sure it works.');

  const saveSchedule = () => runOp('schedule',
    () => api.insightsEmailSchedule({ enabled, send_time: sendTime }),
    enabled ? `Digest on — arrives around ${sendTime}.` : 'Digest paused.');

  const sendTest = () => runOp('test',
    () => api.insightsEmailTest(),
    'Test email sent — check the inbox.');

  const runNow = () => runOp('run',
    () => api.insightsEmailRun(),
    'Digest sent.');

  const clearPw = () => runOp('clearPw',
    () => api.insightsEmailClearPassword(),
    'App password removed. The digest is paused until you add a new one.');

  const last = status?.last_run;

  return (
    <SectionCard title="Daily Insights email" bodyClassName="space-y-4 text-sm">
      <div className="flex items-start gap-2">
        <Mail className="w-3.5 h-3.5 text-muted-foreground mt-0.5 shrink-0" />
        <p className="text-muted-foreground leading-relaxed">
          The Insights resident reads everything COGNOS keeps and emails you a short
          morning digest. Use the Gmail account you made for COGNOS and its app
          password — the password is stored encrypted and never shown again.
          Digests only ever go to that same address.
        </p>
      </div>

      {message && (
        <p className={message.ok ? 'text-ok flex items-start gap-1.5' : 'text-destructive flex items-start gap-1.5'}>
          {message.ok ? <CheckCircle2 className="w-3.5 h-3.5 mt-0.5 shrink-0" /> : <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />}
          <span>{message.text}</span>
        </p>
      )}

      <div className="space-y-2">
        <label className="block">
          <span className="text-xs text-muted-foreground">COGNOS Gmail address</span>
          <TextInput value={email} onChange={(e) => setEmail(e.target.value)}
            placeholder="you@gmail.com" inputMode="email" autoComplete="off" className="mt-1 w-full" />
        </label>
        <label className="block">
          <span className="text-xs text-muted-foreground">{status?.has_password ? 'App password (set — enter a new one to replace it)' : 'App password'}</span>
          <TextInput value={password} onChange={(e) => setPassword(e.target.value)} type="password"
            placeholder="16-character code from your Google account" autoComplete="new-password" className="mt-1 w-full" />
        </label>
        <div className="flex flex-wrap gap-2">
          <Btn variant="secondary" size="sm" onClick={saveCredentials} disabled={busy !== null}>
            {busy === 'save' ? 'Saving…' : 'Save email'}
          </Btn>
          {status?.has_password && (
            <Btn variant="ghost" size="sm" onClick={clearPw} disabled={busy !== null}>
              {busy === 'clearPw' ? 'Removing…' : 'Remove password'}
            </Btn>
          )}
          <Btn variant="secondary" size="sm" onClick={sendTest}
            disabled={busy !== null || !status?.configured}>
            <Send className="w-3.5 h-3.5" /> {busy === 'test' ? 'Sending…' : 'Send test email'}
          </Btn>
        </div>
      </div>

      <div className="space-y-2 border-t border-border/50 pt-3">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-medium">Schedule</span>
          <Badge tone={status?.configured ? (enabled ? 'ok' : 'muted') : 'warn'}>
            {!status?.configured ? 'email not configured' : enabled ? 'on' : 'paused'}
          </Badge>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <button
            className="flex items-center gap-1.5 text-sm border border-border rounded-md px-2.5 py-1.5"
            onClick={() => setEnabled(!enabled)}
            aria-pressed={enabled}
          >
            {enabled ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
            {enabled ? 'Pause' : 'Resume'}
          </button>
          <label className="flex items-center gap-1.5 text-sm text-muted-foreground">
            <Clock className="w-3.5 h-3.5" /> Arrives around
            <input type="time" value={sendTime} onChange={(e) => setSendTime(e.target.value)}
              className="border border-border rounded-md px-2 py-1 text-sm bg-transparent" />
            <span className="text-xs">Eastern</span>
          </label>
          <Btn variant="secondary" size="sm" onClick={saveSchedule} disabled={busy !== null}>
            {busy === 'schedule' ? 'Saving…' : 'Save schedule'}
          </Btn>
        </div>
        <Btn variant="ghost" size="sm" onClick={runNow}
          disabled={busy !== null || !status?.configured}>
          {busy === 'run' ? 'Sending…' : 'Send the digest now'}
        </Btn>
      </div>

      <div className="border-t border-border/50 pt-3 text-xs text-muted-foreground space-y-1">
        <p className="font-medium text-foreground text-sm">Last digest</p>
        {!last ? (
          <p>No digest has run yet.</p>
        ) : (
          <>
            <p>
              <Badge tone={last.status === 'sent' ? 'ok' : last.status === 'failed' ? 'bad' : 'muted'}>
                {last.status}
              </Badge>{' '}
              <span className="ml-1">{formatRunTime(last.started_ms)}</span>
            </p>
            {last.error && <p className="text-destructive">{last.error}</p>}
            {last.preview && last.status === 'sent' && (
              <p className="whitespace-pre-wrap leading-relaxed mt-1 text-foreground/80">{last.preview}</p>
            )}
          </>
        )}
      </div>
    </SectionCard>
  );
}
