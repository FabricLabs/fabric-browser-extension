'use strict';

import React, { useCallback, useEffect, useState } from 'react';
import { Button, Label, List, Message } from 'semantic-ui-react';

export interface PageIndexRow {
  url: string;
  title: string | null;
  merkleRootHex: string;
  blobTotal: number;
  size: number;
  providers: number;
  blobs: Array<{ index: number; blobHashHex: string; size: number }>;
}

function shortHex (v: string): string {
  const s = String(v || '');
  return s.length <= 16 ? s : `${s.slice(0, 8)}…${s.slice(-8)}`;
}

/**
 * Local "legacy web page" index: pages this Passport captured as blob trees,
 * the Tree root each page is located by on the mesh, and how many peers
 * currently advertise its chunks (from the local `DocumentOfferBook`).
 * Mirrors the `fabric-document` presentation (`@fabric/http`): hash-only
 * on the wire; title / URL are local-only.
 */
export function PageIndexPanel (): React.ReactElement {
  const [rows, setRows] = useState<PageIndexRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(() => {
    if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.sendMessage) return;
    setLoading(true);
    setError(null);
    chrome.runtime.sendMessage(
      { type: 'FABRIC_PAGE_INDEX_LIST', limit: 50 },
      (r: { ok?: boolean; items?: PageIndexRow[]; error?: string } | undefined) => {
        setLoading(false);
        if (chrome.runtime.lastError) {
          setError(chrome.runtime.lastError.message ?? 'Extension messaging error');
          return;
        }
        if (r?.ok) setRows(Array.isArray(r.items) ? r.items : []);
        else setError(r?.error || 'Could not read the page index.');
      }
    );
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  return (
    <div className="fabric-page-index">
      <Button size="mini" basic inverted onClick={refresh} loading={loading}>Refresh</Button>
      {error && <Message negative size="mini">{error}</Message>}
      {!error && rows.length === 0 && (
        <p style={{ marginTop: '0.5em', fontSize: '0.85em', color: 'rgba(255,255,255,0.65)' }}>
          No pages indexed yet. Captured pages are split into 24 KiB blobs; peers locate them by Tree root.
        </p>
      )}
      {rows.length > 0 && (
        <List divided relaxed inverted>
          {rows.map((row) => (
            <List.Item key={row.merkleRootHex + row.url}>
              <List.Content>
                <List.Header style={{ wordBreak: 'break-all' }}>{row.title || row.url}</List.Header>
                <List.Description>
                  <code title={row.merkleRootHex} style={{ fontSize: '0.8em' }}>{shortHex(row.merkleRootHex)}</code>
                  {' '}
                  <Label size="mini">{row.blobTotal} blob{row.blobTotal === 1 ? '' : 's'}</Label>
                  <Label size="mini">{row.size} bytes</Label>
                  <Label size="mini" color={row.providers > 0 ? 'green' : undefined}>
                    {row.providers} provider{row.providers === 1 ? '' : 's'}
                  </Label>
                  <Button
                    size="mini"
                    basic
                    inverted
                    compact
                    title="Ask the budget agent to acquire this blob tree"
                    onClick={() => chrome.runtime.sendMessage({ type: 'FABRIC_MARKET_WANT', merkleRootHex: row.merkleRootHex, blobTotal: row.blobTotal }, () => { void chrome.runtime.lastError; })}
                  >Want</Button>
                </List.Description>
              </List.Content>
            </List.Item>
          ))}
        </List>
      )}
    </div>
  );
}

export default PageIndexPanel;
