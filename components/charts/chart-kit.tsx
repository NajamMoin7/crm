"use client";

import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  LabelList,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { fmtValue, type ValueFormat } from "./format";
import { cn } from "@/lib/utils";

/**
 * Chart primitives shared by the dashboard and reports.
 * Spec (dataviz): 2px lines, ≤24px bars with 4px rounded data-ends, hairline
 * recessive grid, one y-axis, legend for ≥2 series, tooltip on every chart,
 * text in text tokens (never the series colour).
 */

export type Series = { key: string; label: string; color: string; opacity?: number };

const AXIS_TICK = { fontSize: 11, fill: "var(--chart-axis)" };

/* ---------------------------------------------------------------- legend */

export function ChartLegend({ items, className }: { items: { label: string; color: string; shape?: "line" | "rect"; opacity?: number }[]; className?: string }) {
  if (items.length < 2) return null;
  return (
    <ul className={cn("flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground", className)} aria-label="Legend">
      {items.map((it) => (
        <li key={it.label} className="flex items-center gap-1.5">
          {it.shape === "line" ? (
            <span aria-hidden className="h-0.5 w-3 rounded-full" style={{ background: it.color }} />
          ) : (
            <span aria-hidden className="size-2.5 rounded-[3px]" style={{ background: it.color, opacity: it.opacity ?? 1 }} />
          )}
          <span className="text-foreground/80">{it.label}</span>
        </li>
      ))}
    </ul>
  );
}

/* --------------------------------------------------------------- tooltip */

type TipRow = { name: string; value: number; color: string; opacity?: number };

function TooltipBox({ title, rows, format, footer }: { title?: string; rows: TipRow[]; format: ValueFormat; footer?: string }) {
  return (
    <div className="min-w-40 rounded-lg border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-md">
      {title && <div className="mb-1.5 font-medium text-muted-foreground">{title}</div>}
      <ul className="space-y-1">
        {rows.map((r) => (
          <li key={r.name} className="flex items-center gap-2">
            <span aria-hidden className="h-0.5 w-3 shrink-0 rounded-full" style={{ background: r.color, opacity: r.opacity ?? 1 }} />
            <span className="text-muted-foreground">{r.name}</span>
            <span className="ml-auto pl-3 font-semibold tabular">{fmtValue(r.value, format)}</span>
          </li>
        ))}
      </ul>
      {footer && <div className="mt-1.5 border-t pt-1.5 text-muted-foreground">{footer}</div>}
    </div>
  );
}

/* ------------------------------------------------------- time-series lines */

export function TimeSeriesChart({
  data,
  series,
  format = "money",
  height = 240,
  ariaLabel,
}: {
  data: Record<string, string | number>[];
  series: Series[];
  format?: ValueFormat;
  height?: number;
  ariaLabel: string;
}) {
  return (
    <div className="space-y-2">
      <ChartLegend items={series.map((s) => ({ label: s.label, color: s.color, shape: "line" }))} />
      <div role="img" aria-label={ariaLabel} style={{ height }}>
        <ResponsiveContainer width="100%" height="100%" initialDimension={{ width: 320, height }}>
          <LineChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
            <CartesianGrid vertical={false} stroke="var(--chart-grid)" />
            <XAxis dataKey="label" tickLine={false} axisLine={false} tick={AXIS_TICK} minTickGap={28} interval="preserveStartEnd" />
            <YAxis
              tickLine={false}
              axisLine={false}
              tick={AXIS_TICK}
              width={52}
              allowDecimals={false}
              tickFormatter={(v: number) => fmtValue(v, format, true)}
            />
            <Tooltip
              cursor={{ stroke: "var(--chart-axis)", strokeWidth: 1 }}
              content={({ active, label, payload }) =>
                active && payload?.length ? (
                  <TooltipBox
                    title={String(label ?? "")}
                    format={format}
                    rows={series.map((s) => ({ name: s.label, color: s.color, value: Number(payload[0]?.payload?.[s.key] ?? 0) }))}
                  />
                ) : null
              }
            />
            {series.map((s) => (
              <Line
                key={s.key}
                type="monotone"
                dataKey={s.key}
                name={s.label}
                stroke={s.color}
                strokeWidth={2}
                strokeLinecap="round"
                strokeLinejoin="round"
                dot={false}
                activeDot={{ r: 4, stroke: "var(--card)", strokeWidth: 2, fill: s.color }}
                isAnimationActive={false}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

/* ---------------------------------------------------- horizontal bar list */

export type HBarDatum = { label: string; value: number; color?: string; note?: string };

export function HBarChart({
  data,
  format = "money",
  color = "var(--chart-7)",
  ariaLabel,
  legend,
  labelWidth = 120,
  valueName = "Value",
}: {
  data: HBarDatum[];
  format?: ValueFormat;
  color?: string;
  ariaLabel: string;
  legend?: { label: string; color: string }[];
  labelWidth?: number;
  valueName?: string;
}) {
  const height = data.length * 30 + 12;
  return (
    <div className="space-y-2">
      {legend && <ChartLegend items={legend} />}
      <div role="img" aria-label={ariaLabel} style={{ height }}>
        <ResponsiveContainer width="100%" height="100%" initialDimension={{ width: 320, height }}>
          <BarChart data={data} layout="vertical" margin={{ top: 4, right: 64, bottom: 4, left: 0 }} barCategoryGap={6}>
            <XAxis type="number" hide />
            <YAxis
              type="category"
              dataKey="label"
              tickLine={false}
              axisLine={false}
              width={labelWidth}
              tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
              tickFormatter={(v: string) => { const max = Math.floor(labelWidth / 6.2); return v.length > max ? `${v.slice(0, max - 1)}…` : v; }}
            />
            <Tooltip
              cursor={{ fill: "var(--accent)", opacity: 0.6 }}
              content={({ active, payload }) => {
                const d = payload?.[0]?.payload as HBarDatum | undefined;
                return active && d ? (
                  <TooltipBox title={d.label} format={format} rows={[{ name: valueName, value: d.value, color: d.color ?? color }]} footer={d.note} />
                ) : null;
              }}
            />
            <Bar dataKey="value" name={valueName} radius={[0, 4, 4, 0]} maxBarSize={20} isAnimationActive={false}>
              {data.map((d) => (
                <Cell key={d.label} fill={d.color ?? color} />
              ))}
              <LabelList
                dataKey="value"
                position="right"
                offset={6}
                style={{ fontSize: 11, fill: "var(--foreground)" }}
                formatter={(v: unknown) => fmtValue(Number(v), format, true)}
              />
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

/* ------------------------------------------------------- grouped columns */

/**
 * Categories on the x-axis, one column per series. When `colorByCategory` is
 * set (brand charts), hue follows the category (brand identity) and each
 * series is a fixed opacity step of that hue — composite encoding with a
 * neutral legend for the series.
 */
export function GroupedBarChart({
  data,
  series,
  format = "money",
  height = 240,
  ariaLabel,
  colorByCategory,
  footerKey,
}: {
  data: (Record<string, string | number> & { label: string; color?: string })[];
  series: Series[];
  format?: ValueFormat;
  height?: number;
  ariaLabel: string;
  colorByCategory?: boolean;
  footerKey?: string;
}) {
  const legend = colorByCategory
    ? series.map((s) => ({ label: s.label, color: "var(--muted-foreground)", opacity: s.opacity ?? 1 }))
    : series.map((s) => ({ label: s.label, color: s.color }));
  return (
    <div className="space-y-2">
      <ChartLegend items={legend} />
      <div role="img" aria-label={ariaLabel} style={{ height }}>
        <ResponsiveContainer width="100%" height="100%" initialDimension={{ width: 320, height }}>
          <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }} barGap={2} barCategoryGap="22%">
            <CartesianGrid vertical={false} stroke="var(--chart-grid)" />
            <XAxis dataKey="label" tickLine={false} axisLine={false} tick={AXIS_TICK} interval={0} />
            <YAxis tickLine={false} axisLine={false} tick={AXIS_TICK} width={52} allowDecimals={false} tickFormatter={(v: number) => fmtValue(v, format, true)} />
            <Tooltip
              cursor={{ fill: "var(--accent)", opacity: 0.6 }}
              content={({ active, payload, label }) => {
                const row = payload?.[0]?.payload as Record<string, string | number> | undefined;
                return active && row ? (
                  <TooltipBox
                    title={String(label ?? "")}
                    format={format}
                    footer={footerKey ? String(row[footerKey] ?? "") || undefined : undefined}
                    rows={series.map((s) => ({
                      name: s.label,
                      value: Number(row[s.key] ?? 0),
                      color: colorByCategory ? String(row.color ?? s.color) : s.color,
                      opacity: colorByCategory ? s.opacity : 1,
                    }))}
                  />
                ) : null;
              }}
            />
            {series.map((s) => (
              <Bar key={s.key} dataKey={s.key} name={s.label} fill={s.color} fillOpacity={s.opacity ?? 1} radius={[4, 4, 0, 0]} maxBarSize={24} isAnimationActive={false}>
                {colorByCategory && data.map((d) => <Cell key={d.label} fill={d.color ?? s.color} fillOpacity={s.opacity ?? 1} />)}
              </Bar>
            ))}
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
