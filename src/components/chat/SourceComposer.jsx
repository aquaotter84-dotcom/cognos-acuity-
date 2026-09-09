import { useEffect, useRef, useState } from 'react';
import { Bot, FileText, Image as ImageIcon, Link as LinkIcon, Loader2, Paperclip, ShieldAlert, X } from 'lucide-react';
import { api } from '@/lib/api';

const MAX_FILE_BYTES = 6_000_000; // base64 JSON must stay under the 10 MB body limit
const ACCEPT = '.pdf,.docx,.txt,.md,.markdown,.csv,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain,text/markdown,text/csv';
const IMAGE_ACCEPT = 'image/png,image/jpeg,image/webp';
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'];

function bytesToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function SourceRow({ source, selected, onToggle }) {
  const risks = Array.isArray(source.risk_flags) ? source.risk_flags : [];
  return (
    <button
      type="button"
      onClick={() => onToggle(source)}
      className={`w-full text-left rounded-lg border px-2.5 py-2 transition-colors ${selected ? 'border-primary bg-primary/10' : 'border-border hover:bg-muted/60'}`}
    >
      <div className="flex items-start gap-2">
        {source.kind === 'link' ? <LinkIcon className="w-3.5 h-3.5 mt-0.5 text-primary shrink-0" /> : (
          source.kind === 'image' ? <ImageIcon className="w-3.5 h-3.5 mt-0.5 text-primary shrink-0" /> : <FileText className="w-3.5 h-3.5 mt-0.5 text-primary shrink-0" />
        )}
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium truncate">{source.name}</p>
          <p className="text-[10px] text-muted-foreground truncate">{source.kind} · {source.media_type}</p>
          {risks.length > 0 && (
            <p className="text-[10px] text-amber-600 dark:text-amber-400 flex items-center gap-1 mt-1">
              <ShieldAlert className="w-3 h-3" /> Untrusted instructions detected
            </p>
          )}
        </div>
        {source.kind === 'image' && source.id && (
          <img
            src={api.imageUrl(source.id)}
            alt=""
            loading="lazy"
            className="w-8 h-8 rounded object-cover border border-border shrink-0"
          />
        )}
      </div>
    </button>
  );
}

export default function SourceComposer({
  conversationId,
  projectId,
  disabled,
  sources,
  onSourcesChange,
  agentMode,
  onAgentModeChange
}) {
  const [open, setOpen] = useState(false);
  const [recent, setRecent] = useState([]);
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const fileRef = useRef(null);
  const imageRef = useRef(null);

  const refresh = async () => {
    try { setRecent(await api.listSources({ limit: 30 })); }
    catch (e) { setError(e.message || 'Could not load sources'); }
  };

  useEffect(() => {
    if (open) refresh();
  }, [open]);

  const toggle = (source) => {
    if (sources.some(item => item.id === source.id)) onSourcesChange(sources.filter(item => item.id !== source.id));
    else if (sources.length < 8) onSourcesChange([...sources, source]);
  };

  const pushSource = (source) => {
    if (!sources.some(item => item.id === source.id)) onSourcesChange([...sources, source].slice(0, 8));
    setOpen(false);
  };

  const upload = async (event, kind) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (file.size > MAX_FILE_BYTES) {
      setError(`File exceeds the ${Math.round(MAX_FILE_BYTES / 1_000_000)} MB limit`);
      return;
    }
    const mediaType = file.type && (kind === 'image' ? IMAGE_TYPES.includes(file.type) : true) ? file.type : (kind === 'image' ? 'image/png' : 'application/octet-stream');
    if (kind === 'image' && !IMAGE_TYPES.includes(mediaType)) {
      setError('Images must be PNG, JPEG, or WebP');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const body = {
        conversationId,
        name: file.name,
        mediaType,
        base64: bytesToBase64(await file.arrayBuffer())
      };
      if (projectId) body.projectId = projectId;
      const source = kind === 'image' ? await api.uploadImage(body) : await api.uploadDocument(body);
      pushSource(source);
      await refresh();
    } catch (e) {
      setError(e.message || (kind === 'image' ? 'Image analysis failed' : 'Document extraction failed'));
    } finally {
      setBusy(false);
    }
  };

  const openUrl = async (event) => {
    event.preventDefault();
    if (!url.trim()) return;
    setBusy(true);
    setError('');
    try {
      const source = await api.openLink({ conversationId, url: url.trim() });
      pushSource(source);
      setUrl('');
      await refresh();
    } catch (e) {
      setError(e.message || 'COGNOS could not open that link');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(value => !value)}
        disabled={disabled}
        aria-expanded={open}
        className={`p-2 rounded-xl transition-colors disabled:opacity-30 ${open || sources.length ? 'text-primary bg-primary/10' : 'text-muted-foreground hover:text-foreground'}`}
        title="Add documents, images, or links"
      >
        <Paperclip className="w-4 h-4" />
      </button>

      <div className="flex items-center gap-1 rounded-lg border border-border bg-muted/30 px-1.5 py-1" title="Bounded agent mode">
        <Bot className="w-3.5 h-3.5 text-muted-foreground" />
        <select
          value={agentMode}
          onChange={event => onAgentModeChange(event.target.value)}
          disabled={disabled}
          aria-label="Agent mode"
          className="bg-transparent text-[11px] outline-none max-w-[88px]"
        >
          <option value="off">Agent off</option>
          <option value="observe">Observe</option>
          <option value="read_only">Read only</option>
          <option value="research">Research</option>
        </select>
      </div>

      {open && (
        <div className="absolute bottom-[calc(100%+0.5rem)] left-0 right-0 z-30 bg-card border border-border rounded-2xl shadow-xl p-3 max-h-[65vh] overflow-y-auto">
          <div className="flex items-center justify-between mb-2">
            <div>
              <h3 className="text-sm font-semibold">Evidence sources</h3>
              <p className="text-[10px] text-muted-foreground">Immutable snapshots · up to 8 per turn</p>
            </div>
            <button type="button" onClick={() => setOpen(false)} className="p-1 rounded hover:bg-muted" aria-label="Close sources">
              <X className="w-4 h-4" />
            </button>
          </div>

          <div className="grid grid-cols-3 gap-2 mb-3">
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              disabled={busy}
              className="rounded-lg border border-border px-2 py-2 text-xs hover:bg-muted disabled:opacity-50 flex items-center justify-center gap-1.5"
              title="PDF, DOCX, TXT, MD, CSV"
            >
              {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <FileText className="w-3.5 h-3.5" />}
              Document
            </button>
            <input ref={fileRef} type="file" accept={ACCEPT} onChange={e => upload(e, 'document')} className="hidden" />
            <button
              type="button"
              onClick={() => imageRef.current?.click()}
              disabled={busy}
              className="rounded-lg border border-border px-2 py-2 text-xs hover:bg-muted disabled:opacity-50 flex items-center justify-center gap-1.5"
              title="PNG, JPEG, WebP — screenshots, photos, scans, charts"
            >
              {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ImageIcon className="w-3.5 h-3.5" />}
              Image
            </button>
            <input ref={imageRef} type="file" accept={IMAGE_ACCEPT} onChange={e => upload(e, 'image')} className="hidden" />
            <span className="text-[10px] text-muted-foreground self-center leading-tight">PDF DOCX TXT MD CSV · PNG JPEG WebP</span>
          </div>

          <form onSubmit={openUrl} className="flex gap-2 mb-3">
            <input
              type="url"
              value={url}
              onChange={event => setUrl(event.target.value)}
              placeholder="https://example.com/article"
              className="flex-1 min-w-0 bg-background border border-border rounded-lg px-2.5 py-2 text-xs outline-none focus:border-primary/60"
            />
            <button type="submit" disabled={busy || !url.trim()} className="rounded-lg bg-primary text-primary-foreground px-3 text-xs disabled:opacity-40">
              Open
            </button>
          </form>

          {error && <p className="text-xs text-destructive mb-3">{error}</p>}

          <div className="space-y-1.5">
            {recent.length ? recent.map(source => (
              <SourceRow key={source.id} source={source} selected={sources.some(item => item.id === source.id)} onToggle={toggle} />
            )) : <p className="text-xs text-muted-foreground py-3 text-center">No sources yet.</p>}
          </div>

          <div className="mt-3 pt-3 border-t border-border text-[10px] text-muted-foreground space-y-1">
            <p><strong>Observe:</strong> records the read plan but opens no URLs automatically.</p>
            <p><strong>Read only:</strong> may safely open explicit URLs in your message. It cannot write memory or release an answer.</p>
            <p><strong>Research:</strong> inspects the project's evidence, proposes a finite plan, and opens approved links only after you approve each step. It never answers on its own.</p>
          </div>
        </div>
      )}
    </>
  );
}
