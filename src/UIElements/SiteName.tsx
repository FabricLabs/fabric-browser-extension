'use strict';

import React from 'react';
import { Label, Message } from 'semantic-ui-react';
import type { SiteView } from '../utils/siteIdentity';

/**
 * A site as prompts show it: the registrable domain in bold, the rest of the
 * host quiet, a "New site" badge, and warnings for look-alikes and
 * international characters.
 */
export default function SiteName (props: { site: SiteView }): React.ReactElement {
  const { site } = props;
  return (
    <div>
      <div style={{ fontSize: '1.15em', wordBreak: 'break-all' }}>
        <span style={{ opacity: 0.6 }}>{site.scheme}://{site.prefix}</span>
        <strong>{site.registrable}</strong>
        <span style={{ opacity: 0.6 }}>{site.port}</span>
        {site.firstSeen ? <Label size="mini" color="yellow" style={{ marginLeft: '0.5em' }}>New site</Label> : null}
      </div>
      {site.lookalike ? (
        <Message warning size="small">
          This is <strong>{site.registrable}</strong>, not <strong>{site.lookalike}</strong>. Look-alike
          names are a common trick; continue only if you meant this site.
        </Message>
      ) : null}
      {site.international ? (
        <Message warning size="small">
          This address uses international characters that can imitate other letters.
        </Message>
      ) : null}
    </div>
  );
}
