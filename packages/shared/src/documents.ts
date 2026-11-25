import { z } from 'zod';

/** Folder in the ZIP export (client answer Q44): Identity, UBO, Client_Documents, Other. */
export const DocumentCategory = z.enum(['IDENTITY', 'UBO', 'CLIENT', 'SCREENING', 'OTHER']);
export type DocumentCategory = z.infer<typeof DocumentCategory>;

/** PDF and the image formats phones produce; checked against the file's first bytes too. */
export const DOCUMENT_TYPES = [
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
] as const;
export type DocumentMime = (typeof DOCUMENT_TYPES)[number];

export const MAX_DOCUMENT_BYTES = 20 * 1024 * 1024;

/** What comes with an upload (as query parameters; the body is the file itself). */
export const UploadDocumentInput = z.object({
  category: DocumentCategory,
  casePartyId: z.uuid().optional(),
  fileName: z.string().trim().min(1).max(200),
  description: z.string().trim().max(1000).optional(),
});
export type UploadDocumentInput = z.input<typeof UploadDocumentInput>;
