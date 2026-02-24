import mitt from 'mitt';
import type { AppEvents } from './events';

export const bus = mitt<AppEvents>();
