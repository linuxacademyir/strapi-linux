import React from 'react';
import type { StrapiApp } from '@strapi/strapi/admin';
import { Typography } from '@strapi/design-system';
// Manually define hook names to avoid deep imports
const INJECT_COLUMN_IN_TABLE = 'Admin/CM/pages/ListView/inject-column-in-table';
const MUTATE_EDIT_VIEW_LAYOUT = 'Admin/CM/pages/EditView/mutate-edit-view-layout';

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
    // Disable specific fields in the edit form per content-type
    app.registerHook(MUTATE_EDIT_VIEW_LAYOUT, ({ layout: editLayout, query }) => {
      const contentType = editLayout.settings?.displayName;
      let disabledFields: string[];
      if (contentType === 'Booking') {
        const pathSegments = window.location.pathname.split('/');
        const lastSegment = pathSegments[pathSegments.length - 1];
        const isCreate = lastSegment === 'create';
        disabledFields = isCreate
          ? []
          : ['customer', 'hours', 'price', 'amount', 'transactionId', 'note'];
      } else if (contentType === 'Order') {
        const pathSegments = window.location.pathname.split('/');
        const lastSegment = pathSegments[pathSegments.length - 1];
        const isCreate = lastSegment === 'create';
        disabledFields = isCreate
          ? []
          : ['sponser', 'package', 'price', 'amount', 'quantity', 'transactionId', 'note'];
      } else if (contentType === 'Sponser') {
        disabledFields = ['orders'];
      } else if (contentType === 'Customer') {
        disabledFields = ['bookings'];
      } else if (contentType === 'Donation') {
        // Disable all fields for Donation entries (both create and edit views)
        disabledFields = ['amount', 'name', 'email', 'mobile', 'donationStatus', 'transactionId'];
      } else {
        return { layout: editLayout, query };
      }
      const panels = editLayout.layout.map(panel =>
        panel.map(row =>
          row.map(field =>
            disabledFields.includes(field.name)
              ? { ...field, disabled: true }
              : field
          )
        )
      );
      return { layout: { ...editLayout, layout: panels }, query };
    });
  },
};