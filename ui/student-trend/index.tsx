import { createRoot } from "react-dom/client";
import "../index.css";
import "./index.css";
import { useWidgetProps } from "../hooks/use-widget-props";

type TrendPoint = {
  period: string;
  attendancePct: number;
  gradeScore: number;
};

type TrendAnalysis = {
  averageAttendance: number;
  averageGrade: number;
  attendanceDelta: number;
  gradeDelta: number;
  relationship: number;
  signal: string;
};

type StudentTrendWidgetProps = {
  studentId?: string | number;
  studentName?: string;
  points?: TrendPoint[];
  analysis?: TrendAnalysis;
};

type ChartPoint = TrendPoint & {
  x: number;
  yAttendance: number;
  yGrade: number;
};

const CHART_WIDTH = 840;
const CHART_HEIGHT = 340;
const MARGIN = {
  top: 30,
  right: 38,
  bottom: 56,
  left: 38,
};

function linePath(points: Array<{ x: number; y: number }>): string {
  return points.map((point, index) => `${index === 0 ? "M" : "L"}${point.x},${point.y}`).join(" ");
}

function areaPath(points: Array<{ x: number; y: number }>, baseline: number): string {
  if (points.length === 0) return "";
  const top = points
    .map((point, index) => `${index === 0 ? "M" : "L"}${point.x},${point.y}`)
    .join(" ");
  const tail = `L${points[points.length - 1].x},${baseline} L${points[0].x},${baseline} Z`;
  return `${top} ${tail}`;
}

function formatDelta(value: number): string {
  if (value > 0) return `+${value}`;
  return `${value}`;
}

function relationshipLabel(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 0.7) return "Strong";
  if (abs >= 0.45) return "Moderate";
  if (abs >= 0.2) return "Mild";
  return "Weak";
}

function App() {
  const widgetProps = useWidgetProps<StudentTrendWidgetProps>(() => ({}));
  const studentId = widgetProps.studentId ?? "Unknown";
  const studentName = widgetProps.studentName ?? "";
  const points = widgetProps.points ?? [];
  const analysis = widgetProps.analysis;

  const innerWidth = CHART_WIDTH - MARGIN.left - MARGIN.right;
  const innerHeight = CHART_HEIGHT - MARGIN.top - MARGIN.bottom;

  const chartPoints: ChartPoint[] = points.map((point, index) => {
    const x = MARGIN.left + (index / Math.max(points.length - 1, 1)) * innerWidth;
    const yAttendance = MARGIN.top + (1 - point.attendancePct / 100) * innerHeight;
    const yGrade = MARGIN.top + (1 - point.gradeScore / 100) * innerHeight;
    return { ...point, x, yAttendance, yGrade };
  });

  const attendancePath = linePath(
    chartPoints.map((point) => ({ x: point.x, y: point.yAttendance })),
  );
  const gradePath = linePath(chartPoints.map((point) => ({ x: point.x, y: point.yGrade })));
  const baseline = CHART_HEIGHT - MARGIN.bottom;
  const attendanceArea = areaPath(
    chartPoints.map((point) => ({ x: point.x, y: point.yAttendance })),
    baseline,
  );

  const attendanceDelta = analysis?.attendanceDelta ?? 0;
  const gradeDelta = analysis?.gradeDelta ?? 0;
  const relationship = analysis?.relationship ?? 0;

  return (
    <div className="student-trend-shell">
      <div className="student-trend-header">
        <div>
          <p className="student-trend-kicker">Student trajectory</p>
          <h2 className="student-trend-title">
            {studentName || `-`}
          </h2>
          {studentName ? (
            <p className="student-trend-kicker">ID {studentId}</p>
          ) : null}
        </div>
        <div className="student-trend-pill">{analysis?.signal ?? "No signal"}</div>
      </div>

      <div className="student-trend-summary">
        <article className="student-trend-metric">
          <p className="student-trend-metric-label">Average attendance</p>
          <p className="student-trend-metric-value">{analysis?.averageAttendance ?? "--"}%</p>
        </article>
        <article className="student-trend-metric">
          <p className="student-trend-metric-label">Average grade</p>
          <p className="student-trend-metric-value">{analysis?.averageGrade ?? "--"}</p>
        </article>
        <article className="student-trend-metric">
          <p className="student-trend-metric-label">Attendance shift</p>
          <p className="student-trend-metric-value">{formatDelta(attendanceDelta)} pts</p>
        </article>
        <article className="student-trend-metric">
          <p className="student-trend-metric-label">Grade shift</p>
          <p className="student-trend-metric-value">{formatDelta(gradeDelta)} pts</p>
        </article>
      </div>

      <div className="student-trend-legend">
        <span>
          <i className="student-trend-dot student-trend-dot-attendance" />
          Attendance %
        </span>
        <span>
          <i className="student-trend-dot student-trend-dot-grade" />
          Grade score
        </span>
        <span className="student-trend-correlation">
          {relationshipLabel(relationship)} relationship ({relationship})
        </span>
      </div>

      <div className="student-trend-chart-wrap">
        <svg
          className="student-trend-chart"
          viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
          role="img"
          aria-label="Attendance and grade trend chart"
        >
          <defs>
            <linearGradient id="attendanceAreaFill" x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor="rgba(44, 189, 171, 0.32)" />
              <stop offset="100%" stopColor="rgba(44, 189, 171, 0.02)" />
            </linearGradient>
            <linearGradient id="attendanceStroke" x1="0" x2="1" y1="0" y2="0">
              <stop offset="0%" stopColor="#14b8a6" />
              <stop offset="100%" stopColor="#0891b2" />
            </linearGradient>
            <linearGradient id="gradeStroke" x1="0" x2="1" y1="0" y2="0">
              <stop offset="0%" stopColor="#f97316" />
              <stop offset="100%" stopColor="#ef4444" />
            </linearGradient>
          </defs>

          {[0, 25, 50, 75, 100].map((tick) => {
            const y = MARGIN.top + (1 - tick / 100) * innerHeight;
            return (
              <g key={tick}>
                <line
                  className="student-trend-gridline"
                  x1={MARGIN.left}
                  x2={CHART_WIDTH - MARGIN.right}
                  y1={y}
                  y2={y}
                />
                <text className="student-trend-axis-label" x={8} y={y + 4}>
                  {tick}
                </text>
              </g>
            );
          })}

          {chartPoints.length > 0 ? (
            <>
              <path className="student-trend-area" d={attendanceArea} />
              <path className="student-trend-line student-trend-line-attendance" d={attendancePath} />
              <path className="student-trend-line student-trend-line-grade" d={gradePath} />
              {chartPoints.map((point) => (
                <g key={point.period}>
                  <circle
                    className="student-trend-node student-trend-node-attendance"
                    cx={point.x}
                    cy={point.yAttendance}
                    r={4}
                  />
                  <circle
                    className="student-trend-node student-trend-node-grade"
                    cx={point.x}
                    cy={point.yGrade}
                    r={3.4}
                  />
                  <text className="student-trend-axis-label student-trend-month" x={point.x - 10} y={CHART_HEIGHT - 22}>
                    {point.period}
                  </text>
                </g>
              ))}
            </>
          ) : null}
        </svg>
      </div>
    </div>
  );
}

const root = document.getElementById("student-trend-root");
if (root) {
  createRoot(root).render(<App />);
}
