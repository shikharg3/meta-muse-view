import { Bar, BarChart, ResponsiveContainer } from "recharts";

export function Sparkline({ data, color = "var(--color-primary)" }: { data: number[]; color?: string }) {
  const d = data.map((v, i) => ({ i, v }));
  return (
    <div className="h-6 w-20">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={d}>
          <Bar dataKey="v" fill={color} radius={1} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
