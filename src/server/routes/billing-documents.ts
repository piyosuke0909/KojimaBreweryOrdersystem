import { Hono } from 'hono';
import type { AppEnv } from '../types';
import { body } from '../services/common';
import { deliveryNoteHistory, invoiceDeliveryNotePreview, invoiceDeliveryNotes, issueDeliveryNote, orderDeliveryNotes, reviseInvoicePresentation } from '../services/billing-documents';

export const billingDocumentRoutes = new Hono<AppEnv>();
billingDocumentRoutes.post('/invoices/:id/presentation', async c => {
  const result = await reviseInvoicePresentation(c, c.req.param('id'), await body(c));
  return c.json({ data: result.data }, result.created ? 201 : 200);
});
billingDocumentRoutes.get('/invoices/:id/delivery-notes', async c => c.json({ data: await invoiceDeliveryNotes(c, c.req.param('id')) }));
billingDocumentRoutes.get('/invoices/:id/delivery-notes/preview', async c => c.json({ data: await invoiceDeliveryNotePreview(c, c.req.param('id'), c.req.query('order_id')) }));
billingDocumentRoutes.get('/orders/:id/delivery-notes', async c => c.json({ data: await orderDeliveryNotes(c, c.req.param('id')) }));
billingDocumentRoutes.post('/orders/:id/delivery-notes', async c => {
  const result = await issueDeliveryNote(c, c.req.param('id'), await body(c));
  return c.json({ data: result.data }, result.created ? 201 : 200);
});
billingDocumentRoutes.get('/orders/:id/delivery-notes/:historyId', async c => c.json({ data: await deliveryNoteHistory(c, c.req.param('id'), c.req.param('historyId')) }));
