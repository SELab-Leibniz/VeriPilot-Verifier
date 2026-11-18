import { excerpt } from '../review-task/evidence-utils.mjs';
import { sha256 as digest } from './utils.mjs';

// The caller verifies the segment and supplies its offset and the full source digest.
export function createOriginalSourceAnchor({ ref, sha256, bytes, start, end, byteOffset = 0 }) {
  if (typeof ref !== 'string' || !ref.trim() || typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/iu.test(sha256))
    throw new Error('Invalid original user source identity.');
  if (!Buffer.isBuffer(bytes) || !bytes.length || !Number.isSafeInteger(byteOffset) || byteOffset < 0
    || !Number.isSafeInteger(byteOffset + bytes.length))
    throw new Error('Invalid original user source segment.');

  const range = excerpt(bytes, start, end);
  if (!range.text.trim()) throw new Error('Original user source range contains no text.');
  const anchor = { kind: 'USER_MESSAGE', ref, sha256: sha256.toLowerCase(),
    byteStart: byteOffset + range.byteStart, byteEnd: byteOffset + range.byteEnd };
  return { anchorId: `original-source-${digest(anchor)}`, ...anchor };
}
