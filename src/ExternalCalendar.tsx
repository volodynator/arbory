import React, { useEffect, useMemo, useState } from "react";
import { Calendar as BigCalendar, dateFnsLocalizer, Views } from "react-big-calendar";
import { format, parse, startOfWeek, getDay } from "date-fns";
import { enUS } from "date-fns/locale";
import "react-big-calendar/lib/css/react-big-calendar.css";

type CalendarEvent = {
  id: string;
  title: string;
  due?: string;
  dueTimeSet?: boolean;
  isEvent?: boolean;
  durationMinutes?: number;
};

type Props = {
  events: CalendarEvent[];
  onClose: () => void;
  onSelectEvent: (id: string) => void;
  defaultDate?: Date;
};

const locales = { "en-US": enUS };

const localizer = dateFnsLocalizer({ format, parse, startOfWeek: (date: Date) => startOfWeek(date, { weekStartsOn: 1 }), getDay, locales });

export default function ExternalCalendar({ events, onClose, onSelectEvent, defaultDate }: Props) {
  const [view, setView] = useState<(typeof Views)[keyof typeof Views]>(Views.WEEK);
  const [date, setDate] = useState(defaultDate ?? new Date());

  const items = useMemo(() => {
    return events
      .map((ev) => {
        if (!ev.due) return null;
        const start = new Date(ev.due);
        const allDay = !ev.dueTimeSet;
        const end = ev.isEvent && ev.dueTimeSet && ev.durationMinutes
          ? new Date(start.getTime() + ev.durationMinutes * 60000)
          : allDay
            ? new Date(start.getFullYear(), start.getMonth(), start.getDate() + 1)
            : new Date(start.getTime() + 1 * 60000);
        return {
          id: ev.id,
          title: ev.title,
          start,
          end,
          allDay,
          isEvent: !!ev.isEvent,
          dueTimeSet: !!ev.dueTimeSet,
          timeLabel: ev.isEvent && ev.dueTimeSet
            ? `${format(start, "HH:mm", { locale: enUS })} - ${format(end, "HH:mm", { locale: enUS })}`
            : ev.dueTimeSet
              ? format(start, "HH:mm", { locale: enUS })
              : "",
        };
      })
      .filter(Boolean) as Array<{ id: string; title: string; start: Date; end: Date; allDay: boolean; isEvent: boolean; dueTimeSet: boolean; timeLabel: string }>;
  }, [events]);

  const moveDate = (direction: -1 | 1) => {
    if (view === Views.MONTH) {
      setDate(new Date(date.getFullYear(), date.getMonth() + direction, 1));
      return;
    }

    const step = view === Views.DAY ? 1 : 7;
    setDate(new Date(date.getFullYear(), date.getMonth(), date.getDate() + direction * step));
  };

  const headerLabel =
    view === Views.MONTH
      ? format(date, "MMMM yyyy", { locale: enUS })
      : view === Views.WEEK
        ? `${format(date, "MMMM d, yyyy", { locale: enUS })}`
        : format(date, "MMMM d, yyyy", { locale: enUS });

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        moveDate(-1);
      }

      if (event.key === "ArrowRight") {
        event.preventDefault();
        moveDate(1);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [view, date]);

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 90, background: "#f5f7fb", display: "flex", alignItems: "stretch", justifyContent: "center", padding: 10, gap: 8 }}>
      <button
        className="ghost-btn"
        aria-label="Previous period"
        onClick={() => moveDate(-1)}
        style={{ alignSelf: "center", width: 36, height: 36, borderRadius: 999, display: "grid", placeItems: "center", flex: "0 0 auto", fontSize: 18, padding: 0 }}
      >
        ←
      </button>

      <div className="external-calendar-shell" style={{ width: "min(1400px, 100%)", height: "100%", background: "var(--bg, #fff)", color: "var(--text, #111)", borderRadius: 24, border: "1px solid rgba(0,0,0,0.08)", boxShadow: "0 24px 80px rgba(0,0,0,0.12)", overflow: "hidden", display: "flex", flexDirection: "column", position: "relative" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 6, padding: "6px 12px", borderBottom: "1px solid rgba(0,0,0,0.08)", flex: "0 0 auto" }}>
          <div>
            <strong style={{ display: "block", fontSize: "1rem", lineHeight: 1.1 }}>Calendar</strong>
            <span style={{ display: "block", fontSize: "0.95rem", opacity: 0.72, marginTop: 1 }}>{headerLabel}</span>
          </div>
          <button className="ghost-btn" onClick={onClose} style={{ height: 32, padding: "0 12px", fontSize: "0.95rem" }}>Close</button>
        </div>

        <div style={{ display: "flex", gap: 6, padding: "6px 12px 0", flex: "0 0 auto" }}>
          <button className="ghost-btn" onClick={() => setView(Views.MONTH)} aria-pressed={view === Views.MONTH} style={{ height: 32, padding: "0 12px", fontSize: "0.95rem" }}>Month</button>
          <button className="ghost-btn" onClick={() => setView(Views.WEEK)} aria-pressed={view === Views.WEEK} style={{ height: 32, padding: "0 12px", fontSize: "0.95rem" }}>Week</button>
          <button className="ghost-btn" onClick={() => setView(Views.DAY)} aria-pressed={view === Views.DAY} style={{ height: 32, padding: "0 12px", fontSize: "0.95rem" }}>Day</button>
          <button className="ghost-btn" onClick={() => setDate(defaultDate ?? new Date())} style={{ height: 32, padding: "0 12px", fontSize: "0.95rem" }}>Today</button>
        </div>

        <div style={{ padding: 8, flex: "1 1 auto", minHeight: 0, overflow: "auto" }}>
          <BigCalendar
            localizer={localizer}
            culture="en-US"
            events={items}
            view={view}
            date={date}
            onView={(nextView) => setView(nextView)}
            onNavigate={(nextDate) => setDate(nextDate)}
            views={[Views.MONTH, Views.WEEK, Views.DAY]}
            components={{
              toolbar: () => null,
              event: ({ event }: { event: { timeLabel: string; title: string } }) => (
                <div className="calendar-event-item">
                  {event.timeLabel ? <span className="calendar-event-item-time">{event.timeLabel}</span> : null}
                  <span className="calendar-event-item-title">{event.title}</span>
                </div>
              ),
            }}
            startAccessor="start"
            endAccessor="end"
            titleAccessor="title"
            dayLayoutAlgorithm="no-overlap"
            style={{ height: "100%" }}
            onSelectEvent={(ev: any) => onSelectEvent(ev.id)}
            formats={{
              timeGutterFormat: "HH:mm",
              eventTimeRangeFormat: () => "",
              dayHeaderFormat: (date) => format(date, "EEEE, MMMM d", { locale: enUS }),
              weekdayFormat: (date) => format(date, "EEE", { locale: enUS }),
              dayFormat: (date) => format(date, "d", { locale: enUS }),
            }}
          />
        </div>

      </div>

      <button
        className="ghost-btn"
        aria-label="Next period"
        onClick={() => moveDate(1)}
        style={{ alignSelf: "center", width: 36, height: 36, borderRadius: 999, display: "grid", placeItems: "center", flex: "0 0 auto", fontSize: 18, padding: 0 }}
      >
        →
      </button>
    </div>
  );
}
