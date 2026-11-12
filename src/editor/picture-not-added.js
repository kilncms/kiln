/**
 * What to say when a file chosen as a picture was not added.
 *
 * A tester renamed a text file to end in `.png` and chose it as a picture.
 * The editor said "Image upload failed", and it said the same whatever the
 * reason was. The person could not tell a file that is no picture from a
 * picture the browser cannot read, or from trouble that had nothing to do
 * with the file.
 *
 * The answer always begins "The picture was not added." and then gives the
 * reason and what to do:
 *
 *   - the file holds something other than its name says, or is over the size
 *     limit: the sentence the file rules already have for it (file-policy.js),
 *     the one the service gives for the same file;
 *   - the file is no kind of picture the editor takes, or the browser could
 *     not read it as one (a HEIC photo, a damaged file): to save it as a JPG
 *     or PNG;
 *   - anything else: the reason as plain-failure.js words it.
 *
 * The rules are asked only after the browser has failed with the file. Asking
 * first would refuse kinds that work today, such as a BMP.
 *
 * Pure, so it is tested in node.
 */
import { uploadProblem, editorFileKind } from '../file-policy.js';
import { notDone, said } from './plain-failure.js';

export const PICTURE_NOT_ADDED = 'The picture was not added.';
export const NOT_OPENED_AS_PICTURE = 'This browser could not open that file as a picture. Save it as a JPG or PNG and try again.';

// What a browser calls its own failure to read a file as a picture
// (createImageBitmap, and an <img> asked to decode).
const COULD_NOT_READ = new Set(['InvalidStateError', 'EncodingError']);

/**
 * The line for the person. `name` and `size` are the chosen file's, `head` its
 * first bytes (left out when they could not be read), `err` what was thrown.
 */
export function pictureNotAdded({ name, size, head } = {}, err) {
  // An explanation already written for the person goes as it is.
  if (err && err.said) return notDone(PICTURE_NOT_ADDED, err);
  const problem = uploadProblem(name, { size, head });
  if (problem && (problem.code === 'file_mismatch' || problem.code === 'file_size')) {
    return notDone(PICTURE_NOT_ADDED, said(problem.error));
  }
  if (editorFileKind(name) !== 'image' || COULD_NOT_READ.has(err?.name)) {
    return notDone(PICTURE_NOT_ADDED, said(NOT_OPENED_AS_PICTURE));
  }
  return notDone(PICTURE_NOT_ADDED, err);
}
