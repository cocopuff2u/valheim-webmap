using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using UnityEngine;
using WebMap.Tiles;
using WebMap.Util;

namespace WebMap.World
{
    // The world's biomes as one picture, for the page's "Biomes" map style: SIZE x SIZE cells over the
    // map's square (TileMath.WORLD_SIZE), one solid colour per biome, north up. Worked out once from
    // the world's own generator (the seed decides it, so it never changes) a few rows per frame, and
    // kept as biomes.png beside the world's map data. The big regions get a name label at a spot well
    // inside them; the page shows a label only once its spot is explored.
    internal static class BiomeMap
    {
        public const int SIZE = 2048;                      // ~10.5 m a cell
        private const int FORMAT = 1;
        public static volatile byte[] Png;                  // the whole world, null until ready
        private static byte[] cells;                        // index into Order per cell (255: none), for masking by the fog
        private static byte[] masked; private static int maskedAt = -1; private static DateTime maskedTime;
        private static readonly object maskLock = new object();
        private static List<Label> labels = new List<Label>();
        private struct Label { public string name; public float x, z, area; }

        public static readonly int[] Order = { Palette.B_MEADOWS, Palette.B_BLACKFOREST, Palette.B_SWAMP, Palette.B_MOUNTAIN, Palette.B_PLAINS,
                                               Palette.B_MISTLANDS, Palette.B_ASHLANDS, Palette.B_DEEPNORTH, Palette.B_OCEAN };
        // solid, clearly different colours (the page's key uses the same)
        public static Palette.Rgb Colour(int b)
        {
            switch (b)
            {
                case Palette.B_MEADOWS: return new Palette.Rgb(134, 186, 72);
                case Palette.B_BLACKFOREST: return new Palette.Rgb(46, 92, 56);
                case Palette.B_SWAMP: return new Palette.Rgb(120, 96, 62);
                case Palette.B_MOUNTAIN: return new Palette.Rgb(214, 220, 228);
                case Palette.B_PLAINS: return new Palette.Rgb(222, 196, 88);
                case Palette.B_MISTLANDS: return new Palette.Rgb(98, 104, 120);
                case Palette.B_ASHLANDS: return new Palette.Rgb(176, 64, 42);
                case Palette.B_DEEPNORTH: return new Palette.Rgb(170, 214, 236);
                case Palette.B_OCEAN: return new Palette.Rgb(32, 72, 118);
                default: return new Palette.Rgb(40, 40, 40);
            }
        }

        public static void Start(string worldDataPath)
        {
            string path = Path.Combine(worldDataPath, "biomes.png"), meta = Path.Combine(worldDataPath, "biomes.txt");
            try
            {
                if (File.Exists(path) && File.Exists(meta))
                {
                    var lines = File.ReadAllLines(meta);
                    if (lines.Length > 0 && lines[0] == $"{FORMAT} {SIZE} {TileMath.WORLD_SIZE}")
                    {
                        LoadLabels(lines);
                        string raw = Path.Combine(Path.GetDirectoryName(path), "biomes.cells");
                        byte[] c = File.Exists(raw) ? File.ReadAllBytes(raw) : null;
                        if (c != null && c.Length == SIZE * SIZE) { cells = c; Png = File.ReadAllBytes(path); return; }
                    }
                }
            }
            catch { }
            StaticCoroutine.Start(Build(path, meta));
        }

        private static IEnumerator Build(string path, string meta)
        {
            yield return new WaitForSeconds(5f);
            var started = Time.realtimeSinceStartup;
            var cells = new byte[SIZE * SIZE];   // index into Order (255: none)
            float span = (float)TileMath.WORLD_SIZE / SIZE, half = TileMath.WORLD_HALF;
            var index = new Dictionary<int, byte>();
            for (int i = 0; i < Order.Length; i++) index[Order[i]] = (byte)i;
            for (int row = 0; row < SIZE; row++)
            {
                float wz = half - (row + 0.5f) * span;   // row 0 is the north edge
                for (int col = 0; col < SIZE; col++)
                {
                    float wx = -half + (col + 0.5f) * span;
                    int b = Palette.B_NONE;
                    if (wx * wx + wz * wz < 10500f * 10500f)
                        try { b = (int)WorldGenerator.instance.GetBiome(wx, wz); } catch { }
                    cells[row * SIZE + col] = index.TryGetValue(b, out byte k) ? k : (byte)255;
                }
                if (row % 24 == 23) yield return null;   // a few rows a frame: the server keeps running smoothly
            }
            var px = new byte[SIZE * SIZE * 4];
            for (int i = 0; i < cells.Length; i++)
            {
                if (cells[i] == 255) continue;
                var c = Colour(Order[cells[i]]);
                px[i * 4] = (byte)c.r; px[i * 4 + 1] = (byte)c.g; px[i * 4 + 2] = (byte)c.b; px[i * 4 + 3] = 255;
            }
            byte[] png = Util.Png.Encode(px, SIZE, SIZE, Util.Png.Format.RGBA);
            var found = FindLabels(cells, span, half);
            try
            {
                File.WriteAllBytes(path, png);
                File.WriteAllBytes(Path.Combine(Path.GetDirectoryName(path), "biomes.cells"), cells);   // the grid itself, for masking by the fog
                var sb = new System.Text.StringBuilder();
                sb.Append(FORMAT).Append(' ').Append(SIZE).Append(' ').Append(TileMath.WORLD_SIZE).Append('\n');
                foreach (var l in found) sb.Append(l.name).Append('\t').Append(l.x.ToString("F0")).Append('\t').Append(l.z.ToString("F0")).Append('\t').Append(l.area.ToString("F0")).Append('\n');
                File.WriteAllText(meta, sb.ToString());
            }
            catch (Exception e) { ZLog.LogWarning("WebMap: biomes.png: " + e.Message); }
            labels = found;
            BiomeMap.cells = cells;
            Png = png;
            ZLog.Log($"WebMap: biome map built ({SIZE}x{SIZE}, {found.Count} named regions) in {Time.realtimeSinceStartup - started:F1} s");
        }

        // the big regions of each biome (not the ocean): connected cells on a coarser grid, each named at
        // the cell inside it farthest from its edge (well inside, not at a centroid that may fall outside)
        private static List<Label> FindLabels(byte[] cells, float span, float half)
        {
            const int C = 512; int f = SIZE / C; float cs = span * f;
            var g = new byte[C * C];
            for (int y = 0; y < C; y++) for (int x = 0; x < C; x++) g[y * C + x] = cells[(y * f + f / 2) * SIZE + x * f + f / 2];
            var seen = new bool[C * C]; var outList = new List<Label>();
            var q = new Queue<int>(); var comp = new List<int>();
            for (int s = 0; s < g.Length; s++)
            {
                if (seen[s] || g[s] == 255 || Order[g[s]] == Palette.B_OCEAN) { seen[s] = true; continue; }
                byte k = g[s]; comp.Clear(); q.Enqueue(s); seen[s] = true;
                while (q.Count > 0)
                {
                    int i = q.Dequeue(); comp.Add(i); int x = i % C, y = i / C;
                    if (x > 0 && !seen[i - 1] && g[i - 1] == k) { seen[i - 1] = true; q.Enqueue(i - 1); }
                    if (x < C - 1 && !seen[i + 1] && g[i + 1] == k) { seen[i + 1] = true; q.Enqueue(i + 1); }
                    if (y > 0 && !seen[i - C] && g[i - C] == k) { seen[i - C] = true; q.Enqueue(i - C); }
                    if (y < C - 1 && !seen[i + C] && g[i + C] == k) { seen[i + C] = true; q.Enqueue(i + C); }
                }
                float area = comp.Count * cs * cs;
                if (area < 1.2e6f) continue;   // only regions over ~1.2 km2 get a name
                // the cell farthest from the region's edge, from a distance-to-edge pass
                var inside = new HashSet<int>(comp); int best = comp[0], bestD = -1;
                var dist = new Dictionary<int, int>(); var bq = new Queue<int>();
                foreach (int i in comp)
                {
                    int x = i % C, y = i / C;
                    bool edge = x == 0 || y == 0 || x == C - 1 || y == C - 1 || !inside.Contains(i - 1) || !inside.Contains(i + 1) || !inside.Contains(i - C) || !inside.Contains(i + C);
                    if (edge) { dist[i] = 0; bq.Enqueue(i); }
                }
                while (bq.Count > 0)
                {
                    int i = bq.Dequeue(); int d = dist[i];
                    if (d > bestD) { bestD = d; best = i; }
                    foreach (int n in new[] { i - 1, i + 1, i - C, i + C })
                        if (inside.Contains(n) && !dist.ContainsKey(n)) { dist[n] = d + 1; bq.Enqueue(n); }
                }
                int bx = best % C, by = best / C;
                outList.Add(new Label { name = Palette.BiomeName(Order[k]), x = -half + (bx + 0.5f) * cs, z = half - (by + 0.5f) * cs, area = area });
            }
            return outList;
        }

        // The picture the page gets: only explored ground shows (the rest clear, under the fog anyway), so
        // the world's layout can't be read off the file. Remade when exploration grew, at most once a minute.
        public static byte[] PngFor()
        {
            if (Png == null) return null;
            if (WebMapConfig.REVEAL_ALL || cells == null) return Png;
            lock (maskLock)
            {
                int now = Fog.ExploredCells;
                if (masked != null && (now == maskedAt || (DateTime.UtcNow - maskedTime).TotalSeconds < 60)) return masked;   // the web server's thread: no Unity clock here
                float span = (float)TileMath.WORLD_SIZE / SIZE, half = TileMath.WORLD_HALF;
                var px = new byte[SIZE * SIZE * 4];
                var col = new Palette.Rgb[Order.Length];
                for (int i = 0; i < Order.Length; i++) col[i] = Colour(Order[i]);
                for (int y = 0; y < SIZE; y++)
                {
                    float wz = half - (y + 0.5f) * span;
                    for (int x = 0; x < SIZE; x++)
                    {
                        int k = cells[y * SIZE + x];
                        if (k == 255 || !Fog.IsExplored(-half + (x + 0.5f) * span, wz)) continue;
                        int o = (y * SIZE + x) * 4; var c = col[k];
                        px[o] = (byte)c.r; px[o + 1] = (byte)c.g; px[o + 2] = (byte)c.b; px[o + 3] = 255;
                    }
                }
                masked = Util.Png.Encode(px, SIZE, SIZE, Util.Png.Format.RGBA);
                maskedAt = now; maskedTime = DateTime.UtcNow;
                return masked;
            }
        }

        private static void LoadLabels(string[] lines)
        {
            var l = new List<Label>();
            for (int i = 1; i < lines.Length; i++)
            {
                var t = lines[i].Split('\t');
                if (t.Length == 4 && float.TryParse(t[1], out float x) && float.TryParse(t[2], out float z) && float.TryParse(t[3], out float a))
                    l.Add(new Label { name = t[0], x = x, z = z, area = a });
            }
            labels = l;
        }

        // the named regions whose label spot is explored (or all with reveal_all), for the page
        public static string LabelsJson()
        {
            var j = new JsonWriter(4096);
            j.BeginObject().Prop("ready", Png != null).Prop("size", SIZE).Prop("world", TileMath.WORLD_SIZE).Key("labels").BeginArray();
            foreach (var l in labels)
            {
                if (!WebMapConfig.REVEAL_ALL && !Fog.IsExplored(l.x, l.z)) continue;
                j.BeginObject().Prop("name", l.name).Prop("x", l.x, 0).Prop("z", l.z, 0).Prop("area", l.area, 0).End();
            }
            j.End().Key("colours").BeginObject();
            foreach (int b in Order) { var c = Colour(b); j.Prop(Palette.BiomeName(b), $"#{c.r:x2}{c.g:x2}{c.b:x2}"); }
            j.End().End();
            return j.ToString();
        }
    }
}
