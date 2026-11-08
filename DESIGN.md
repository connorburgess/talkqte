# TalkQTE interface

The interface is a quiet meeting companion with a friendly notebook. Rounded forms, readable type, and generous actions make a question approachable without adding pressure to answer. This is an implementation direction, not a final brand identity.

- Deep evergreen navigation, warm paper work areas, dark ink, and muted terracotta for the primary demo action.
- Rounded system type where the platform supplies it, with native sans-serif fallbacks. Body and question evidence use 16px text; the question uses 24px. Tabular numerals are reserved for elapsed time and counts.
- A stable sidebar, searchable meeting list, and spacious note editor. The active question appears in a dedicated companion area or a separate desktop window.
- Show one useful question, with visible Save question and Dismiss actions. Questions expire quietly in the engine; there is no visible countdown or shrinking time bar and no response score.
- The desktop companion anchors at the bottom-right of the notebook display. Its resting bar is 320 × 76 logical pixels, including a small opaque paper frame, and shows explicit demo status plus labeled Pause/Resume and Hide controls. A question expands upward and leftward to 420 × 420 while the bottom-right corner stays put, clamped to the available work area. It returns to the bar on pause, save, dismissal, or expiry.
- Use 16px control corners and 24–28px panel/question corners, with consistent stroke icons. The native window remains opaque; its inner companion surface is rounded without enabling private transparency APIs.
- Primary actions are at least 48px high and icon controls at least 44px in each dimension. Keep a clear focus ring on both paper and forest surfaces. Separators organize content without enclosing every paragraph in a card.
- Hover, focus, loading, error, empty, paused, and ended states are part of the interface. Reduced motion removes control transitions. No bounce, pulsing, or celebratory animation competes with the meeting.
- All sample content is labeled demo. No fake capture status, model readiness, integrations, or persistence guarantees.
