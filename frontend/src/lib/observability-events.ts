// Keep the dashboard app on the same event helpers shipped by the shadcn
// registry item so timestamp handling does not drift between the two surfaces.
export {
  getEventCreatedAt,
  getEventTimeRange,
  sortEventsByCreatedAt,
} from '../../../packages/ui/registry/new-york/observability-events/events'
