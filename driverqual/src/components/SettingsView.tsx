'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/client';

interface SecretStatus {
  key: string;
  configured: boolean;
  hint: string | null;
  source: 'database' | 'environment' | 'none';
  updatedAt: string | null;
}

interface SettingsPayload {
  openai: SecretStatus;
  fmcsa: SecretStatus;
  extractionModel: string;
  defaultModel: string;
  uploadPolicy: {
    maxBytes: number;
    acceptedExtensions: string[];
    maxFilesPerApplicant: number;
  };
}

const OPENAI_KEY = 'openai_api_key';
const FMCSA_KEY = 'fmcsa_api_key';
const MODEL_KEY = 'openai_model';

export function SettingsView() {
  const [settings, setSettings] = useState<SettingsPayload | null>(null);
  const [openaiInput, setOpenaiInput] = useState('');
  const [fmcsaInput, setFmcsaInput] = useState('');
  const [modelInput, setModelInput] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const result = await api<SettingsPayload>('/api/settings');
    if (result.ok) {
      setSettings(result.data);
      setModelInput(result.data.extractionModel);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function save(key: string, value: string | null, label: string) {
    setError(null);
    setNotice(null);
    const result = await api('/api/settings', { method: 'PUT', json: { key, value } });
    if (!result.ok) {
      setError(result.data.error ?? `${label} could not be saved.`);
      return;
    }
    setNotice(value ? `${label} saved.` : `${label} removed.`);
    setOpenaiInput('');
    setFmcsaInput('');
    await refresh();
  }

  if (!settings) return <p className="muted">Loading settings…</p>;

  return (
    <>
      <h1 className="page-title">Settings</h1>
      <p className="page-sub">
        Integration credentials are stored server-side and are never returned to the browser in
        full.
      </p>

      {error && (
        <div className="alert alert-error" role="alert" data-testid="settings-error">
          {error}
        </div>
      )}
      {notice && (
        <div className="alert alert-success" data-testid="settings-notice">
          {notice}
        </div>
      )}

      <div className="card" style={{ marginBottom: 16 }}>
        <h2 style={{ margin: '0 0 4px', fontSize: 16 }}>OpenAI extraction</h2>
        <p className="muted" style={{ marginTop: 0 }}>
          Status:{' '}
          <strong data-testid="openai-status">
            {settings.openai.configured ? `Connected (${settings.openai.hint})` : 'Not configured'}
          </strong>
          {settings.openai.source === 'environment' && ' — supplied by a deployment secret'}
        </p>
        <div className="field">
          <label htmlFor="openaiKey">API key</label>
          <input
            id="openaiKey"
            type="password"
            autoComplete="off"
            placeholder="sk-…"
            data-testid="openai-key-input"
            value={openaiInput}
            onChange={(e) => setOpenaiInput(e.target.value)}
          />
        </div>
        <div className="row">
          <button
            type="button"
            className="btn btn-primary"
            data-testid="save-openai"
            onClick={() => save(OPENAI_KEY, openaiInput, 'OpenAI API key')}
          >
            Save / connect
          </button>
          <button type="button" className="btn btn-secondary" onClick={refresh}>
            Refresh status
          </button>
          <button
            type="button"
            className="btn btn-danger"
            onClick={() => save(OPENAI_KEY, null, 'OpenAI API key')}
          >
            Remove
          </button>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <h2 style={{ margin: '0 0 4px', fontSize: 16 }}>FMCSA lookup</h2>
        <p className="muted" style={{ marginTop: 0 }}>
          Status:{' '}
          <strong data-testid="fmcsa-status">
            {settings.fmcsa.configured ? `Configured (${settings.fmcsa.hint})` : 'Not configured'}
          </strong>
        </p>
        <div className="field">
          <label htmlFor="fmcsaKey">FMCSA web key</label>
          <input
            id="fmcsaKey"
            type="password"
            autoComplete="off"
            value={fmcsaInput}
            onChange={(e) => setFmcsaInput(e.target.value)}
          />
        </div>
        <div className="row">
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => save(FMCSA_KEY, fmcsaInput, 'FMCSA web key')}
          >
            Save
          </button>
          <button
            type="button"
            className="btn btn-danger"
            onClick={() => save(FMCSA_KEY, null, 'FMCSA web key')}
          >
            Remove
          </button>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <h2 style={{ margin: '0 0 4px', fontSize: 16 }}>Extraction model</h2>
        <div className="field">
          <label htmlFor="model">Model</label>
          <input id="model" value={modelInput} onChange={(e) => setModelInput(e.target.value)} />
          <span className="muted">Default: {settings.defaultModel}</span>
        </div>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => save(MODEL_KEY, modelInput, 'Extraction model')}
        >
          Save model
        </button>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <h2 style={{ margin: '0 0 4px', fontSize: 16 }}>Uploads</h2>
        <p style={{ margin: '4px 0' }}>
          Accepted formats: {settings.uploadPolicy.acceptedExtensions.join(', ')}
        </p>
        <p style={{ margin: '4px 0' }}>
          Maximum size: {settings.uploadPolicy.maxBytes / 1024 / 1024} MB per file, up to{' '}
          {settings.uploadPolicy.maxFilesPerApplicant} files per read.
        </p>
      </div>

      <div className="card">
        <h2 style={{ margin: '0 0 4px', fontSize: 16 }}>Security</h2>
        <ul className="reasons">
          <li>Secrets are held server-side and returned only as a masked status.</li>
          <li>Uploads are re-validated on the server for extension, content type and size.</li>
          <li>Every guideline, document and evaluation change is written to an append-only log.</li>
          <li>Evaluations record their guideline version, evidence snapshot and engine version.</li>
          <li>AI output is decision support; a qualified human records the final decision.</li>
        </ul>
      </div>
    </>
  );
}
