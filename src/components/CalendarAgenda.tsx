import { useEffect, useRef, useState } from 'react';
import {
  Calendar,
  ChevronLeft,
  ChevronRight,
  RefreshCw,
  Video,
  X,
} from 'lucide-react';
import {
  addDays,
  buildWeekWindow,
  CALENDAR_RESULTS_LIMITED_DETAIL,
  CALENDAR_RESULTS_LIMITED_SHORT,
  clampDate,
  eventsForDate,
  formatClockTime,
  formatDayHeading,
  formatEventTimeRange,
  formatWeekDayParts,
  hasEventsOnDate,
  isOngoingEvent,
  remainingMinutes,
  type CalendarAgendaEvent,
  type CalendarAgendaSnapshot,
} from '../lib/calendarAgenda';
import './calendar-agenda.css';

function freshnessLabel(snapshot: CalendarAgendaSnapshot): string {
  if (snapshot.permission === 'denied') return 'Calendar permission off';
  if (snapshot.syncState === 'loading') return 'Loading Apple Calendar…';
  if (snapshot.syncState === 'refreshing') return 'Refreshing…';
  if (snapshot.agendaEnabled && snapshot.permission === 'off') {
    return 'Waiting for Calendar permission';
  }
  if (snapshot.pausedWhileLive) {
    const time = snapshot.lastUpdatedEpochMs
      ? formatClockTime(snapshot.lastUpdatedEpochMs)
      : 'earlier';
    return snapshot.stale
      ? `Stale · cached ${time} (paused while live)`
      : `Paused while live · cached ${time}`;
  }
  if (snapshot.stale) {
    return snapshot.lastUpdatedEpochMs
      ? `Stale · last updated ${formatClockTime(snapshot.lastUpdatedEpochMs)}`
      : 'Stale · Apple Calendar (local cache)';
  }
  if (snapshot.lastUpdatedEpochMs) {
    return `Apple Calendar (local cache) · Updated ${formatClockTime(snapshot.lastUpdatedEpochMs)}`;
  }
  return 'Apple Calendar (local cache)';
}

/** Compact Ready-state Calendar Home band. Adapts to TalkQTE's simplified
 * desktop scale: quiet one-line opt-in when off; calm 7-day strip + chronological
 * agenda when enabled. Selecting an event prepares the local session title only
 * and never starts capture or contacts a provider. */
export function CalendarAgenda({
  snapshot,
  busy,
  error,
  preparedKey,
  nowEpochS,
  onEnable,
  onRefresh,
  onOpenSettings,
  onOpenSystemSettings,
  onPrepare,
  onClearPrepared,
}: {
  snapshot: CalendarAgendaSnapshot | null;
  busy: boolean;
  error: string;
  preparedKey: string | null;
  nowEpochS: number;
  onEnable: () => void;
  onRefresh: () => void;
  onOpenSettings: () => void;
  onOpenSystemSettings: () => void;
  onPrepare: (event: CalendarAgendaEvent) => void;
  onClearPrepared: () => void;
}) {
  const [selectedDate, setSelectedDate] = useState<string>(
    snapshot?.todayLocalDate ?? '',
  );
  const prevTodayRef = useRef<string>(snapshot?.todayLocalDate ?? '');
  const dayButtonRefs = useRef<Record<string, HTMLButtonElement | null>>({});

  // Keep selectedDate valid within the horizon and follow midnight rollover
  // automatically if the user was viewing Today.
  useEffect(() => {
    if (!snapshot) return;
    const prevToday = prevTodayRef.current;
    prevTodayRef.current = snapshot.todayLocalDate;
    setSelectedDate((current) => {
      if (!current || current === prevToday) return snapshot.todayLocalDate;
      return clampDate(
        current,
        snapshot.horizonStartDate,
        snapshot.horizonEndDate,
      );
    });
  }, [
    snapshot?.todayLocalDate,
    snapshot?.horizonStartDate,
    snapshot?.horizonEndDate,
  ]);

  if (!snapshot || snapshot.permission === 'unavailable') return null;

  // Default-off state: one quiet line with explicit opt-in and zero bloat.
  if (!snapshot.agendaEnabled) {
    return (
      <section
        className="calendar-optin-bar"
        aria-label="Apple Calendar agenda"
      >
        <div className="calendar-optin-copy">
          <Calendar
            size={15}
            aria-hidden="true"
            className="calendar-optin-icon"
          />
          <span>
            <strong>Calendar agenda is off.</strong> See upcoming Apple Calendar
            meetings (local Mac cache) before you start.
          </span>
        </div>
        <div className="calendar-optin-actions">
          <button
            type="button"
            className="secondary-button calendar-compact-btn"
            disabled={busy}
            onClick={onEnable}
          >
            Turn on agenda
          </button>
          <button
            type="button"
            className="text-button calendar-settings-link"
            onClick={onOpenSettings}
          >
            Calendar settings
          </button>
        </div>
      </section>
    );
  }

  const activeDate = selectedDate || snapshot.todayLocalDate;
  const weekDates = buildWeekWindow(
    activeDate,
    snapshot.todayLocalDate,
    snapshot.horizonStartDate,
    snapshot.horizonEndDate,
  );
  const { allDay, timed, overlappingKeys } = eventsForDate(
    snapshot.events,
    activeDate,
  );
  const canPrev = activeDate > snapshot.horizonStartDate;
  const canNext = activeDate < snapshot.horizonEndDate;
  const isToday = activeDate === snapshot.todayLocalDate;
  const allHidden =
    snapshot.permission === 'connected' &&
    snapshot.calendars.length > 0 &&
    snapshot.calendars.every((c) => !c.included);
  const alertMessage = error || snapshot.error || '';
  const showLoadingSkeleton =
    snapshot.syncState === 'loading' &&
    snapshot.events.length === 0 &&
    snapshot.permission !== 'denied';
  const waitingForPermission =
    snapshot.permission === 'off' &&
    !showLoadingSkeleton &&
    snapshot.syncState !== 'refreshing';
  const showStaleNotice =
    snapshot.stale &&
    !alertMessage &&
    snapshot.permission === 'connected' &&
    !showLoadingSkeleton;

  const moveSelectedDay = (nextDate: string, focusPill = false) => {
    const clamped = clampDate(
      nextDate,
      snapshot.horizonStartDate,
      snapshot.horizonEndDate,
    );
    setSelectedDate(clamped);
    if (focusPill) {
      requestAnimationFrame(() => dayButtonRefs.current[clamped]?.focus());
    }
  };

  return (
    <section className="calendar-agenda-panel" aria-label="Calendar agenda">
      <div className="calendar-agenda-head">
        <div className="calendar-agenda-nav">
          <h2 className="calendar-agenda-day">
            {snapshot.permission === 'denied' ||
            showLoadingSkeleton ||
            waitingForPermission
              ? 'Apple Calendar'
              : formatDayHeading(activeDate, snapshot.todayLocalDate)}
          </h2>
          {snapshot.permission !== 'denied' &&
            !showLoadingSkeleton &&
            !waitingForPermission && (
              <div
                className="calendar-date-controls"
                role="group"
                aria-label="Change day"
              >
                <button
                  type="button"
                  className="icon-button calendar-nav-btn"
                  aria-label="Previous day"
                  disabled={!canPrev}
                  onClick={() => moveSelectedDay(addDays(activeDate, -1))}
                >
                  <ChevronLeft size={15} aria-hidden="true" />
                </button>
                <button
                  type="button"
                  className="secondary-button calendar-today-btn"
                  disabled={isToday}
                  onClick={() => moveSelectedDay(snapshot.todayLocalDate)}
                >
                  Today
                </button>
                <button
                  type="button"
                  className="icon-button calendar-nav-btn"
                  aria-label="Next day"
                  disabled={!canNext}
                  onClick={() => moveSelectedDay(addDays(activeDate, 1))}
                >
                  <ChevronRight size={15} aria-hidden="true" />
                </button>
              </div>
            )}
        </div>

        <div className="calendar-agenda-meta">
          <span
            className={`calendar-freshness${snapshot.stale || snapshot.permission === 'denied' || waitingForPermission ? ' is-warn' : ''}`}
            role="status"
          >
            {freshnessLabel(snapshot)}
          </span>
          <button
            type="button"
            className="icon-button calendar-nav-btn"
            aria-label="Refresh calendar agenda"
            title="Refresh from Apple Calendar"
            disabled={busy || snapshot.syncState === 'refreshing'}
            onClick={onRefresh}
          >
            <RefreshCw
              size={14}
              aria-hidden="true"
              className={
                snapshot.syncState === 'refreshing' ? 'is-spinning' : undefined
              }
            />
          </button>
          <button
            type="button"
            className="text-button calendar-settings-link"
            onClick={onOpenSettings}
          >
            Calendar settings
          </button>
        </div>
      </div>

      {alertMessage && (
        <div className="calendar-agenda-alert" role="alert">
          <span>{alertMessage}</span>
          <button
            type="button"
            className="secondary-button calendar-compact-btn"
            disabled={busy}
            onClick={onRefresh}
          >
            Retry
          </button>
        </div>
      )}

      {showStaleNotice && (
        <div className="calendar-stale-bar" role="status">
          <span>
            Showing a cached schedule
            {snapshot.lastUpdatedEpochMs
              ? ` from ${formatClockTime(snapshot.lastUpdatedEpochMs)}`
              : ''}
            . Refresh to check Apple Calendar for recent changes.
          </span>
          <button
            type="button"
            className="secondary-button calendar-compact-btn"
            disabled={busy || snapshot.syncState === 'refreshing'}
            onClick={onRefresh}
          >
            Refresh now
          </button>
        </div>
      )}

      {snapshot.permission === 'denied' ? (
        <div className="calendar-agenda-empty">
          <p>
            Calendar access is off or was revoked in macOS System Settings →
            Privacy &amp; Security → Calendars. Cached events are cleared; you
            can still start an ad-hoc session above.
          </p>
          <div className="calendar-empty-actions">
            <button
              type="button"
              className="secondary-button calendar-compact-btn"
              disabled={busy}
              onClick={onOpenSystemSettings}
            >
              Open Calendar privacy settings
            </button>
            <button
              type="button"
              className="secondary-button calendar-compact-btn"
              disabled={busy}
              onClick={onRefresh}
            >
              Check again
            </button>
          </div>
        </div>
      ) : waitingForPermission ? (
        <div className="calendar-agenda-empty">
          <p>
            Apple Calendar access has not been granted yet. Allow access to see
            upcoming meetings, or start an ad-hoc session above.
          </p>
          <div className="calendar-empty-actions">
            <button
              type="button"
              className="secondary-button calendar-compact-btn"
              disabled={busy}
              onClick={onEnable}
            >
              Request access again
            </button>
            <button
              type="button"
              className="secondary-button calendar-compact-btn"
              disabled={busy}
              onClick={onRefresh}
            >
              Check again
            </button>
          </div>
        </div>
      ) : showLoadingSkeleton ? (
        <div
          className="calendar-agenda-skeleton"
          aria-busy="true"
          aria-label="Loading upcoming meetings"
        >
          <div className="calendar-skeleton-row" />
          <div className="calendar-skeleton-row" />
          <div className="calendar-skeleton-row is-short" />
        </div>
      ) : (
        <>
          <div
            className="calendar-week-strip"
            role="group"
            aria-label="Week schedule"
            onKeyDown={(event) => {
              if (event.key === 'ArrowLeft') {
                event.preventDefault();
                moveSelectedDay(addDays(activeDate, -1), true);
              } else if (event.key === 'ArrowRight') {
                event.preventDefault();
                moveSelectedDay(addDays(activeDate, 1), true);
              } else if (event.key === 'Home') {
                event.preventDefault();
                moveSelectedDay(weekDates[0], true);
              } else if (event.key === 'End') {
                event.preventDefault();
                moveSelectedDay(weekDates[weekDates.length - 1], true);
              }
            }}
          >
            {weekDates.map((date) => {
              const { weekday, dayNum, fullLabel } = formatWeekDayParts(date);
              const selected = date === activeDate;
              const today = date === snapshot.todayLocalDate;
              const hasItems = hasEventsOnDate(snapshot.events, date);
              return (
                <button
                  key={date}
                  ref={(node) => {
                    dayButtonRefs.current[date] = node;
                  }}
                  type="button"
                  className={`calendar-day-pill${selected ? ' is-selected' : ''}${today ? ' is-today' : ''}`}
                  aria-pressed={selected}
                  aria-label={`${fullLabel}${today ? ', today' : ''}${hasItems ? ', has meetings' : ''}`}
                  onClick={() => moveSelectedDay(date)}
                >
                  <span className="calendar-day-weekday">{weekday}</span>
                  <span className="calendar-day-num">{dayNum}</span>
                  <span
                    className={`calendar-day-dot${hasItems ? ' has-events' : ''}`}
                    aria-hidden="true"
                  />
                </button>
              );
            })}
          </div>

          {allHidden ? (
            <div className="calendar-agenda-empty">
              <p>
                All calendars are hidden. Choose calendars in Settings, or start
                an ad-hoc session above.
              </p>
              <button
                type="button"
                className="secondary-button calendar-compact-btn"
                onClick={onOpenSettings}
              >
                Choose calendars
              </button>
            </div>
          ) : (
            <>
              {allDay.length > 0 && (
                <div
                  className="calendar-allday-strip"
                  role="group"
                  aria-label="All-day events"
                >
                  <span className="calendar-allday-label">All day</span>
                  <div className="calendar-allday-items">
                    {allDay.map((event) => {
                      const prepared = preparedKey === event.occurrenceKey;
                      return (
                        <button
                          key={event.occurrenceKey}
                          type="button"
                          className={`calendar-allday-chip${prepared ? ' is-prepared' : ''}`}
                          aria-pressed={prepared}
                          onClick={() =>
                            prepared ? onClearPrepared() : onPrepare(event)
                          }
                        >
                          <span>{event.title}</span>
                          {prepared && (
                            <span className="calendar-prepared-tag">
                              Prepared
                            </span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              {timed.length === 0 && allDay.length === 0 ? (
                <p className="calendar-agenda-none">
                  {snapshot.truncated
                    ? `No meetings shown for ${formatDayHeading(activeDate, snapshot.todayLocalDate)}. You can still write notes or start an ad-hoc session above.`
                    : `No meetings scheduled for ${formatDayHeading(activeDate, snapshot.todayLocalDate)}. You can still write notes or start an ad-hoc session above.`}
                </p>
              ) : (
                timed.length > 0 && (
                  <ul className="calendar-event-list">
                    {timed.map((event) => {
                      const ongoing = isOngoingEvent(event, nowEpochS);
                      const prepared = preparedKey === event.occurrenceKey;
                      const overlaps = overlappingKeys.has(event.occurrenceKey);
                      return (
                        <li key={event.occurrenceKey}>
                          <button
                            type="button"
                            className={`calendar-event-row${ongoing ? ' is-now' : ''}${prepared ? ' is-prepared' : ''}`}
                            aria-pressed={prepared}
                            onClick={() =>
                              prepared ? onClearPrepared() : onPrepare(event)
                            }
                          >
                            <span className="calendar-event-time">
                              {ongoing ? (
                                <>
                                  <span className="calendar-now-label">
                                    NOW
                                  </span>
                                  <span>
                                    {remainingMinutes(event, nowEpochS)}m left
                                  </span>
                                </>
                              ) : (
                                formatEventTimeRange(
                                  event.startEpochS,
                                  event.endEpochS,
                                  {
                                    isoDate: activeDate,
                                    localDate: event.localDate,
                                    endLocalDate: event.endLocalDate,
                                  },
                                )
                              )}
                            </span>
                            <span className="calendar-event-main">
                              <span className="calendar-event-title">
                                {event.title}
                              </span>
                              <span className="calendar-event-meta">
                                <span>{event.calendarTitle}</span>
                                {event.hasMeetingLink && (
                                  <span className="calendar-event-tag">
                                    <Video size={11} aria-hidden="true" />
                                    Video link
                                  </span>
                                )}
                                {overlaps && (
                                  <span className="calendar-event-tag is-warn">
                                    Overlaps
                                  </span>
                                )}
                              </span>
                            </span>
                            <span className="calendar-event-action">
                              {prepared ? (
                                <span className="calendar-prepared-tag">
                                  Prepared
                                </span>
                              ) : (
                                <span className="calendar-prepare-hint">
                                  Prepare
                                </span>
                              )}
                            </span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )
              )}

              {snapshot.truncated && (
                <div className="calendar-truncated-note" role="status">
                  <span>{CALENDAR_RESULTS_LIMITED_DETAIL}</span>
                  <button
                    type="button"
                    className="text-button calendar-settings-link"
                    onClick={onOpenSettings}
                  >
                    Filter calendars
                  </button>
                </div>
              )}
            </>
          )}
        </>
      )}
    </section>
  );
}

/** Compact, non-blocking live-session schedule drawer. Keeps Stop, Pause,
 * Turn off, and consent primary while showing cached local-schedule context
 * with explicit paused-while-live, stale, loading, unknown, and revocation
 * honesty. Strictly read-only: never alters live capture or session title. */
export function LiveScheduleGlance({
  id,
  snapshot,
  open,
  busy,
  error,
  nowEpochS,
  onClose,
  onRefresh,
  onOpenSettings,
  onOpenSystemSettings,
}: {
  id?: string;
  snapshot: CalendarAgendaSnapshot | null;
  open: boolean;
  busy: boolean;
  error: string;
  nowEpochS: number;
  onClose: () => void;
  onRefresh: () => void;
  onOpenSettings?: () => void;
  onOpenSystemSettings: () => void;
}) {
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  if (!open || !snapshot || !snapshot.agendaEnabled) return null;

  const { allDay, timed } = eventsForDate(
    snapshot.events,
    snapshot.todayLocalDate,
  );
  const upcomingTimed = timed.filter((e) => e.endEpochS > nowEpochS);
  const displayTimed = upcomingTimed.length > 0 ? upcomingTimed : timed;
  const alertMessage = error || snapshot.error || '';
  const showLoadingSkeleton =
    snapshot.syncState === 'loading' &&
    snapshot.events.length === 0 &&
    snapshot.permission !== 'denied';
  const waitingForPermission =
    snapshot.permission === 'off' &&
    !showLoadingSkeleton &&
    snapshot.syncState !== 'refreshing';
  const allHidden =
    snapshot.permission === 'connected' &&
    snapshot.calendars.length > 0 &&
    snapshot.calendars.every((c) => !c.included);

  return (
    <section
      id={id}
      className="calendar-live-glance"
      aria-label="Schedule glance"
    >
      <div className="calendar-live-glance-head">
        <div className="calendar-live-glance-title">
          <h2>Schedule glance</h2>
          <span
            className={`calendar-freshness${snapshot.stale || snapshot.permission === 'denied' || waitingForPermission ? ' is-warn' : ''}`}
            role="status"
          >
            {freshnessLabel(snapshot)}
          </span>
        </div>
        <div className="calendar-live-glance-actions">
          <button
            type="button"
            className="secondary-button calendar-compact-btn"
            disabled={busy || snapshot.syncState === 'refreshing'}
            onClick={onRefresh}
          >
            <RefreshCw
              size={13}
              aria-hidden="true"
              className={
                snapshot.syncState === 'refreshing' ? 'is-spinning' : undefined
              }
            />
            Refresh
          </button>
          <button
            type="button"
            className="icon-button calendar-nav-btn"
            aria-label="Close schedule glance"
            onClick={onClose}
          >
            <X size={15} aria-hidden="true" />
          </button>
        </div>
      </div>

      {alertMessage && (
        <div className="calendar-agenda-alert" role="alert">
          <span>{alertMessage}</span>
          <button
            type="button"
            className="secondary-button calendar-compact-btn"
            disabled={busy}
            onClick={onRefresh}
          >
            Retry
          </button>
        </div>
      )}

      {snapshot.permission === 'denied' ? (
        <div className="calendar-agenda-empty">
          <p>
            Calendar access was revoked in macOS System Settings. Cached events
            are cleared, and your live session continues unaffected.
          </p>
          <div className="calendar-empty-actions">
            <button
              type="button"
              className="secondary-button calendar-compact-btn"
              disabled={busy}
              onClick={onOpenSystemSettings}
            >
              Open Calendar privacy settings
            </button>
            <button
              type="button"
              className="secondary-button calendar-compact-btn"
              disabled={busy}
              onClick={onRefresh}
            >
              Check again
            </button>
          </div>
        </div>
      ) : showLoadingSkeleton ? (
        <div
          className="calendar-agenda-skeleton"
          aria-busy="true"
          aria-label="Loading upcoming meetings"
        >
          <div className="calendar-skeleton-row" />
          <div className="calendar-skeleton-row is-short" />
        </div>
      ) : waitingForPermission ? (
        <div className="calendar-agenda-empty">
          <p>
            Apple Calendar permission has not been granted yet. Your live
            session continues unaffected.
          </p>
          <button
            type="button"
            className="secondary-button calendar-compact-btn"
            disabled={busy}
            onClick={onRefresh}
          >
            Check again
          </button>
        </div>
      ) : allHidden ? (
        <div className="calendar-agenda-empty">
          <p>
            All calendars are hidden in Settings. Your live session continues
            unaffected.
          </p>
          {onOpenSettings && (
            <button
              type="button"
              className="secondary-button calendar-compact-btn"
              onClick={onOpenSettings}
            >
              Choose calendars
            </button>
          )}
        </div>
      ) : displayTimed.length === 0 && allDay.length === 0 ? (
        <p className="calendar-agenda-none">
          {snapshot.truncated
            ? `No more meetings shown on today’s cached schedule. ${CALENDAR_RESULTS_LIMITED_SHORT}`
            : 'No more meetings on today’s cached schedule.'}
        </p>
      ) : (
        <>
          <ul className="calendar-glance-list">
            {allDay.map((event) => (
              <li key={event.occurrenceKey} className="calendar-glance-item">
                <span className="calendar-glance-time">All day</span>
                <span className="calendar-glance-name">{event.title}</span>
                <span className="calendar-glance-cal">
                  {event.calendarTitle}
                </span>
              </li>
            ))}
            {displayTimed.slice(0, 6).map((event) => {
              const ongoing = isOngoingEvent(event, nowEpochS);
              return (
                <li
                  key={event.occurrenceKey}
                  className={`calendar-glance-item${ongoing ? ' is-now' : ''}`}
                >
                  <span className="calendar-glance-time">
                    {ongoing
                      ? `NOW · ${remainingMinutes(event, nowEpochS)}m left`
                      : formatEventTimeRange(
                          event.startEpochS,
                          event.endEpochS,
                          {
                            isoDate: snapshot.todayLocalDate,
                            localDate: event.localDate,
                            endLocalDate: event.endLocalDate,
                          },
                        )}
                  </span>
                  <span className="calendar-glance-name">{event.title}</span>
                  <span className="calendar-glance-cal">
                    {event.calendarTitle}
                  </span>
                </li>
              );
            })}
          </ul>
          {snapshot.truncated && (
            <p className="calendar-agenda-footnote" role="status">
              {CALENDAR_RESULTS_LIMITED_SHORT}
            </p>
          )}
        </>
      )}
    </section>
  );
}
