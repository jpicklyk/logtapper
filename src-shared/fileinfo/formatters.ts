// Thin re-export over the shared nanosecond timestamp/duration formatters
// (see ../../utils/timeFormat) so FileInfoPanel's call sites and tests keep
// their existing names.
export { formatTimestamp } from '../utils/timeFormat';
export { formatDurationBetween as formatDuration } from '../utils/timeFormat';
