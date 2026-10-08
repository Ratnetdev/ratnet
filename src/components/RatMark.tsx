// Pixel rat mark. Drawn from a bitmap so it stays crisp at any size.
const ROWS = [
  "...........##....",
  "..........#..#...",
  ".....#######..#..",
  "...###########.#.",
  "..############..#",
  "..#############.#",
  "..##############.",
  ".#.###########...",
  "#...#..#...#..#..",
  "#................",
  ".#...............",
];

export default function RatMark({ size = 28, color = "currentColor" }: { size?: number; color?: string }) {
  const w = ROWS[0].length;
  const h = ROWS.length;
  const rects: React.JSX.Element[] = [];
  ROWS.forEach((row, y) =>
    row.split("").forEach((c, x) => {
      if (c === "#") rects.push(<rect key={`${x}-${y}`} x={x} y={y} width={1.02} height={1.02} />);
    })
  );
  return (
    <svg width={size} height={(size * h) / w} viewBox={`0 0 ${w} ${h}`} fill={color} shapeRendering="crispEdges" aria-hidden>
      {rects}
    </svg>
  );
}
