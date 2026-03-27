import {
  BarChart,
  Bar,
  LineChart,
  Line,
  ScatterChart,
  Scatter,
  PieChart,
  Pie,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
  AreaChart,
  Area,
} from 'recharts';
import type { ChartData } from '../bridge/types';

interface Props {
  chart: ChartData;
  onPointClick?: (timelinePos: number) => void;
}

const COLORS = [
  '#58a6ff', '#3fb950', '#d29922', '#f85149', '#bc8cff',
  '#79c0ff', '#56d364', '#e3b341', '#ff7b72', '#d2a8ff',
];

function formatX(chart: ChartData, x: number): string {
  if (chart.chartType === 'time_series' || chart.chartType === 'area') {
    // Nanos since epoch → HH:MM:SS
    const ms = Math.floor(x / 1_000_000);
    const d = new Date(ms);
    return d.toISOString().slice(11, 19);
  }
  return String(x);
}

export default function ProcessorChart({ chart, onPointClick }: Props) {
  const { chartType, title, series, xAxis, yAxis } = chart;

  if (series.length === 0) {
    return (
      <div className="chart-empty">
        <div className="chart-title">{title}</div>
        <div className="chart-no-data">No data</div>
      </div>
    );
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handleClick = (data: any) => {
    if (!onPointClick) return;
    const pos = data?.activePayload?.[0]?.payload?.timelinePos;
    if (pos != null) onPointClick(pos as number);
  };

  return (
    <div className="chart-container">
      <div className="chart-title">{title}</div>
      <ResponsiveContainer width="100%" height={200}>
        {chartType === 'bar' ? (
          <BarChart
            data={series[0].points.map((p) => ({
              x: p.label ?? String(p.x),
              y: p.y,
              timelinePos: p.timelinePos,
            }))}
            onClick={handleClick}
          >
            <CartesianGrid strokeDasharray="3 3" stroke="#21262d" />
            <XAxis dataKey="x" tick={{ fill: '#8b949e', fontSize: 10 }} />
            <YAxis tick={{ fill: '#8b949e', fontSize: 10 }} label={{ value: yAxis.label, angle: -90, fill: '#8b949e', fontSize: 10 }} />
            <Tooltip contentStyle={{ background: '#161b22', border: '1px solid #30363d', fontSize: 11 }} />
            {series.map((s, i) => (
              <Bar key={s.label} dataKey="y" name={s.label} fill={s.color ?? COLORS[i % COLORS.length]} />
            ))}
          </BarChart>
        ) : chartType === 'time_series' ? (
          <LineChart
            data={series[0].points.map((p) => ({ x: formatX(chart, p.x), y: p.y, timelinePos: p.timelinePos }))}
            onClick={handleClick}
          >
            <CartesianGrid strokeDasharray="3 3" stroke="#21262d" />
            <XAxis dataKey="x" tick={{ fill: '#8b949e', fontSize: 9 }} />
            <YAxis tick={{ fill: '#8b949e', fontSize: 10 }} />
            <Tooltip contentStyle={{ background: '#161b22', border: '1px solid #30363d', fontSize: 11 }} />
            <Legend wrapperStyle={{ fontSize: 10 }} />
            {series.map((s, i) => (
              <Line key={s.label} dataKey="y" data={s.points.map((p) => ({ x: formatX(chart, p.x), y: p.y }))} name={s.label} stroke={s.color ?? COLORS[i % COLORS.length]} dot={false} strokeWidth={1.5} />
            ))}
          </LineChart>
        ) : chartType === 'area' ? (
          <AreaChart
            data={series[0].points.map((p) => ({ x: formatX(chart, p.x), y: p.y }))}
            onClick={handleClick}
          >
            <CartesianGrid strokeDasharray="3 3" stroke="#21262d" />
            <XAxis dataKey="x" tick={{ fill: '#8b949e', fontSize: 9 }} />
            <YAxis tick={{ fill: '#8b949e', fontSize: 10 }} />
            <Tooltip contentStyle={{ background: '#161b22', border: '1px solid #30363d', fontSize: 11 }} />
            {series.map((s, i) => (
              <Area key={s.label} dataKey="y" name={s.label} stroke={s.color ?? COLORS[i % COLORS.length]} fill={`${s.color ?? COLORS[i % COLORS.length]}33`} strokeWidth={1.5} />
            ))}
          </AreaChart>
        ) : chartType === 'scatter' ? (
          <ScatterChart onClick={handleClick}>
            <CartesianGrid strokeDasharray="3 3" stroke="#21262d" />
            <XAxis dataKey="x" name={xAxis.label} tick={{ fill: '#8b949e', fontSize: 10 }} />
            <YAxis dataKey="y" name={yAxis.label} tick={{ fill: '#8b949e', fontSize: 10 }} />
            <Tooltip cursor={{ strokeDasharray: '3 3' }} contentStyle={{ background: '#161b22', border: '1px solid #30363d', fontSize: 11 }} />
            {series.map((s, i) => (
              <Scatter key={s.label} name={s.label} data={s.points} fill={s.color ?? COLORS[i % COLORS.length]} />
            ))}
          </ScatterChart>
        ) : chartType === 'pie' ? (
          <PieChart>
            <Pie data={series[0].points.map((p) => ({ name: p.label ?? String(p.x), value: p.y, timelinePos: p.timelinePos }))} dataKey="value" nameKey="name" onClick={(d: any) => { if (onPointClick && d.timelinePos != null) onPointClick(d.timelinePos as number); }}>
              {series[0].points.map((_, i) => (
                <Cell key={i} fill={COLORS[i % COLORS.length]} />
              ))}
            </Pie>
            <Tooltip contentStyle={{ background: '#161b22', border: '1px solid #30363d', fontSize: 11 }} />
            <Legend wrapperStyle={{ fontSize: 10 }} />
          </PieChart>
        ) : (
          // histogram — rendered as bar
          <BarChart data={series[0].points.map((p) => ({ x: p.x.toFixed(1), y: p.y }))} onClick={handleClick}>
            <CartesianGrid strokeDasharray="3 3" stroke="#21262d" />
            <XAxis dataKey="x" tick={{ fill: '#8b949e', fontSize: 9 }} />
            <YAxis tick={{ fill: '#8b949e', fontSize: 10 }} />
            <Tooltip contentStyle={{ background: '#161b22', border: '1px solid #30363d', fontSize: 11 }} />
            <Bar dataKey="y" fill={COLORS[0]} />
          </BarChart>
        )}
      </ResponsiveContainer>
    </div>
  );
}
