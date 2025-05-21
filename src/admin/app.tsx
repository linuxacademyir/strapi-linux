import React from 'react';
import type { StrapiApp } from '@strapi/strapi/admin';
// Manually define the hook name to avoid deep imports
const INJECT_COLUMN_IN_TABLE = 'Admin/CM/pages/ListView/inject-column-in-table';
import { Typography } from '@strapi/design-system';

export default {
  // Optional: configure available locales in the Admin
  config: {
    locales: [],
  },
  bootstrap(app: StrapiApp) {
    // Inject a custom cell formatter for the 'meetingUrl' column
    app.registerHook(INJECT_COLUMN_IN_TABLE, ({ displayedHeaders, layout }) => {
      const updated = displayedHeaders.map(header => {
        if (header.name === 'meetingUrl') {
          return {
            ...header,
            // Render the URL as a clickable link
            cellFormatter: (row, hdr) => {
              const url = row[hdr.name as keyof typeof row] as string;
              return (
                <Typography
                  textColor="primary600"
                  as="a"
                  href={url}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {url}
                </Typography>
              );
            },
          };
        }
        return header;
      });
      return { displayedHeaders: updated, layout };
    });
  },
};