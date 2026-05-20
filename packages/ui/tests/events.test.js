import { describe, expect, test } from 'bun:test';
import { getEventCreatedAt, getEventTimeRange, sortEventsByCreatedAt, } from '../registry/new-york/observability-events/events';
describe('observability event utilities', () => {
    test('parses numeric and string created_at values', () => {
        expect(getEventCreatedAt({ type: 'numeric', created_at: 2 })).toBe(2);
        expect(getEventCreatedAt({
            type: 'string',
            created_at: '1970-01-01T00:00:03Z',
        })).toBe(3);
        expect(getEventCreatedAt({ type: 'missing' })).toBeNull();
    });
    test('sorts timed events chronologically and keeps untimed events last', () => {
        const sorted = sortEventsByCreatedAt([
            { type: 'late', created_at: 3 },
            { type: 'untimed' },
            { type: 'early', created_at: 1 },
            { type: 'middle', created_at: '1970-01-01T00:00:02Z' },
        ]);
        expect(sorted?.map((event) => event.type)).toEqual([
            'early',
            'middle',
            'late',
            'untimed',
        ]);
    });
    test('computes ranges from timed events only', () => {
        const range = getEventTimeRange([
            { type: 'first', created_at: 1 },
            { type: 'last', created_at: 4 },
            { type: 'untimed' },
        ]);
        expect(range).toEqual({ start: 1, end: 4 });
    });
});
