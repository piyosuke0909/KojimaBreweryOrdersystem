import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import './DeliveryDateCalendar.css';

interface Props {
  dates: string[];
  selectedDate: string;
  onSelect: (date: string) => void;
}

const weekdays = ['日', '月', '火', '水', '木', '金', '土'];
const dayMs = 86_400_000;
const toDate = (value: string) => new Date(`${value}T00:00:00Z`);
const iso = (date: Date) => date.toISOString().slice(0, 10);
const shiftDay = (value: string, amount: number) => iso(new Date(toDate(value).getTime() + amount * dayMs));
const shiftMonth = (month: string, amount: number) => {
  const date = toDate(`${month}-01`);
  date.setUTCMonth(date.getUTCMonth() + amount);
  return iso(date).slice(0, 7);
};
const validDate = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(toDate(value).getTime()) && iso(toDate(value)) === value;

export default function DeliveryDateCalendar({ dates, selectedDate, onSelect }: Props) {
  const available = useMemo(() => [...new Set(dates.filter(validDate))].sort(), [dates]);
  const allowed = useMemo(() => new Set(available), [available]);
  const initialMonth = (allowed.has(selectedDate) ? selectedDate : available[0] || iso(new Date())).slice(0, 7);
  const [shownMonth, setShownMonth] = useState(initialMonth);
  const [focusedDate, setFocusedDate] = useState(selectedDate);
  const pendingFocus = useRef<string | null>(null);
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const headingId = useId();
  const helpId = useId();
  const minMonth = available[0]?.slice(0, 7) || initialMonth;
  const maxMonth = available.at(-1)?.slice(0, 7) || initialMonth;
  const month = shownMonth < minMonth || shownMonth > maxMonth ? initialMonth : shownMonth;
  const visibleDates = available.filter(date => date.startsWith(month));
  const tabDate = visibleDates.includes(focusedDate) ? focusedDate : visibleDates.includes(selectedDate) ? selectedDate : visibleDates[0];
  const firstDay = toDate(`${month}-01`);
  const year = firstDay.getUTCFullYear();
  const monthNumber = firstDay.getUTCMonth();
  const dayCount = new Date(Date.UTC(year, monthNumber + 1, 0)).getUTCDate();
  const offset = firstDay.getUTCDay();
  const cells = Array.from({ length: Math.ceil((offset + dayCount) / 7) * 7 }, (_, index) => {
    const day = index - offset + 1;
    return day > 0 && day <= dayCount ? `${month}-${String(day).padStart(2, '0')}` : null;
  });
  const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

  useEffect(() => {
    if (!pendingFocus.current) return;
    buttons.current.get(pendingFocus.current)?.focus();
    pendingFocus.current = null;
  }, [month, focusedDate]);

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>, date: string) => {
    let target: string | undefined;
    if (event.key === 'ArrowLeft') target = available.filter(value => value < date).at(-1);
    else if (event.key === 'ArrowRight') target = available.find(value => value > date);
    else if (event.key === 'ArrowUp') target = available.filter(value => value <= shiftDay(date, -7)).at(-1);
    else if (event.key === 'ArrowDown') target = available.find(value => value >= shiftDay(date, 7));
    else if (event.key === 'Home' || event.key === 'End') {
      const start = shiftDay(date, -toDate(date).getUTCDay());
      const end = shiftDay(start, 6);
      const week = available.filter(value => value >= start && value <= end);
      target = event.key === 'Home' ? week[0] : week.at(-1);
    } else if (event.key === 'PageUp' || event.key === 'PageDown') {
      const nextMonth = shiftMonth(date.slice(0, 7), event.key === 'PageUp' ? -1 : 1);
      const candidates = available.filter(value => value.startsWith(nextMonth));
      target = candidates.reduce<string | undefined>((nearest, value) => !nearest || Math.abs(Number(value.slice(-2)) - Number(date.slice(-2))) < Math.abs(Number(nearest.slice(-2)) - Number(date.slice(-2))) ? value : nearest, undefined);
    } else return;
    event.preventDefault();
    if (target) {
      if (target === focusedDate && target.startsWith(month)) {
        buttons.current.get(target)?.focus();
        return;
      }
      pendingFocus.current = target;
      setFocusedDate(target);
      setShownMonth(target.slice(0, 7));
    }
  };

  return <div className="ko-delivery-calendar">
    <div className="ko-calendar-toolbar">
      <button type="button" className="ko-calendar-navigation" aria-label="前の月" disabled={month <= minMonth} onClick={() => setShownMonth(shiftMonth(month, -1))}><ChevronLeft size={20} aria-hidden="true" /></button>
      <h3 id={headingId} className="ko-calendar-month" aria-live="polite">{year}年{monthNumber + 1}月</h3>
      <button type="button" className="ko-calendar-navigation" aria-label="次の月" disabled={month >= maxMonth} onClick={() => setShownMonth(shiftMonth(month, 1))}><ChevronRight size={20} aria-hidden="true" /></button>
    </div>
    <p id={helpId} className="ko-calendar-help">選択できる日から到着希望日を選んでください。</p>
    <table className="ko-calendar-grid" role="grid" aria-labelledby={headingId} aria-describedby={helpId}>
      <thead><tr role="row">{weekdays.map(day => <th key={day} scope="col" role="columnheader" aria-label={`${day}曜日`}>{day}</th>)}</tr></thead>
      <tbody>{Array.from({ length: cells.length / 7 }, (_, row) => <tr key={row} role="row">
        {cells.slice(row * 7, row * 7 + 7).map((date, column) => <td key={date || `empty-${column}`} role="gridcell" aria-selected={date ? date === selectedDate : undefined}>
          {date && <button type="button" className={`ko-calendar-day${date === selectedDate ? ' active' : ''}${date === today ? ' today' : ''}`} disabled={!allowed.has(date)} tabIndex={date === tabDate ? 0 : -1} aria-label={`${year}年${monthNumber + 1}月${Number(date.slice(-2))}日（${weekdays[column]}）${allowed.has(date) ? '' : '・選択できません'}`} aria-pressed={date === selectedDate} aria-current={date === today ? 'date' : undefined} ref={node => { if (node) buttons.current.set(date, node); else buttons.current.delete(date); }} onFocus={() => setFocusedDate(date)} onKeyDown={event => handleKeyDown(event, date)} onClick={() => onSelect(date)}>{Number(date.slice(-2))}</button>}
        </td>)}
      </tr>)}</tbody>
    </table>
    {!visibleDates.length && <p className="ko-calendar-help" role="status">この月は選択できる日がありません。</p>}
    <p className="ko-calendar-keyboard-help">キーボードでは矢印キーで日付、Page Up・Page Downで月を移動できます。</p>
  </div>;
}
