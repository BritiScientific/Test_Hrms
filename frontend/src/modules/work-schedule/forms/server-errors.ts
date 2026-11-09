import { errorText, isStale, serverFieldErrors } from '../hooks';

/**
 * Route a failed save to the right place: STALE_VERSION to the stale notice
 * (input kept), field errors (NAME_TAKEN, VALIDATION_FAILED, INACTIVE_REFERENCE
 * all carry details.fieldErrors) onto their fields, anything else to the form.
 */
export function routeServerError(e: unknown, o: {
  isField: (key: string) => boolean;
  setFieldError: (key: string, message: string) => void;
  setFormError: (message: string | null) => void;
  setStale: (stale: boolean) => void;
}) {
  if (isStale(e)) {
    o.setStale(true);
    return;
  }
  const fields = serverFieldErrors(e);
  const leftover: string[] = [];
  for (const [key, message] of Object.entries(fields)) {
    if (o.isField(key)) o.setFieldError(key, message);
    else leftover.push(message);
  }
  if (!Object.keys(fields).length) o.setFormError(errorText(e));
  else if (leftover.length) o.setFormError(leftover.join(' '));
}
