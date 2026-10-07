using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading;
using UnityEngine;
using WebMap.Models;
using WebMap.Models.Unity;
using WebMap.Util;

namespace WebMap.World
{
    // The game's own map icons (the spawn stones, traders, the pin types, death, boss...) for the web
    // map. The game keeps them as sprites in one UI atlas; a dedicated server has the Minimap and
    // knows each sprite's rectangle, but with no graphics device the atlas pixels can't be read
    // through Unity. So the atlas is found in the game's own files and decoded (TextureExtractor,
    // BC7) once, each icon cut out to map_data/icons/<sprite>.png, with icons.json listing them by
    // location or pin type. Nothing of the game's art is shipped; a game update (new atlas name)
    // extracts again.
    internal static class MapIcons
    {
        private static readonly BepInEx.Logging.ManualLogSource log = BepInEx.Logging.Logger.CreateLogSource("WebMap.icons");
        private sealed class Entry { public string key, sprite; public Rect rect; }

        public static string Dir { get; private set; }
        public static volatile string ManifestJson = "{\"icons\":{}}";

        public static void Start(string mapDataPath)
        {
            try
            {
                Dir = Path.Combine(mapDataPath, "icons");
                Directory.CreateDirectory(Dir);
                var mm = Minimap.instance ?? Resources.FindObjectsOfTypeAll<Minimap>().FirstOrDefault();
                if (mm == null) { log.LogInfo("no Minimap on this server: using the map's own icons"); return; }
                var entries = new List<Entry>();
                string atlas = null;
                void Add(string key, Sprite s)
                {
                    if (s == null || s.texture == null) return;
                    if (atlas == null) atlas = s.texture.name;
                    if (s.texture.name != atlas) return;   // all of them live in the one atlas today
                    entries.Add(new Entry { key = key, sprite = s.name, rect = s.textureRect });
                }
                foreach (var l in mm.m_locationIcons) Add(l.m_name, l.m_icon);
                foreach (var i in mm.m_icons) Add("pin:" + i.m_name, i.m_icon);
                if (atlas == null || entries.Count == 0) return;
                string manifest = BuildManifest(atlas, entries);
                string mf = Path.Combine(Dir, "icons.json");
                if (File.Exists(mf) && File.ReadAllText(mf) == manifest && entries.All(e => File.Exists(Path.Combine(Dir, e.sprite + ".png"))))
                {
                    ManifestJson = manifest;
                    log.LogInfo($"{entries.Count} game map icons ready");
                    return;
                }
                string dataDir = Application.dataPath;
                new Thread(() => Extract(dataDir, atlas, entries, manifest, mf)) { IsBackground = true, Name = "WebMap icons", Priority = System.Threading.ThreadPriority.BelowNormal }.Start();
            }
            catch (Exception e) { log.LogWarning("map icons: " + e.Message); }
        }

        private static string BuildManifest(string atlas, List<Entry> entries)
        {
            var j = new JsonWriter(2048);
            j.BeginObject().Prop("atlas", atlas).Key("icons").BeginObject();
            foreach (var e in entries) j.Prop(e.key, e.sprite);
            j.End().End();
            return j.ToString();
        }

        private static void Extract(string dataDir, string atlas, List<Entry> entries, string manifest, string mf)
        {
            var sw = System.Diagnostics.Stopwatch.StartNew();
            try
            {
                byte[] rgba = TextureExtractor.FindTexture(dataDir, atlas, out int w, out int h);
                if (rgba == null) { log.LogWarning($"map icons: atlas {atlas} not found in the game files; using the map's own icons"); return; }
                foreach (var e in entries)
                {
                    int x0 = Mathf.Clamp(Mathf.RoundToInt(e.rect.x), 0, w), y0 = Mathf.Clamp(Mathf.RoundToInt(e.rect.y), 0, h);
                    int cw = Mathf.Clamp(Mathf.RoundToInt(e.rect.width), 1, w - x0), ch = Mathf.Clamp(Mathf.RoundToInt(e.rect.height), 1, h - y0);
                    var px = new byte[cw * ch * 4];
                    for (int r = 0; r < ch; r++)   // atlas rows run bottom-up, like the rect's y
                        Buffer.BlockCopy(rgba, ((y0 + ch - 1 - r) * w + x0) * 4, px, r * cw * 4, cw * 4);
                    File.WriteAllBytes(Path.Combine(Dir, e.sprite + ".png"), Png.Encode(px, cw, ch, Png.Format.RGBA));
                }
                File.WriteAllText(mf, manifest);
                ManifestJson = manifest;
                log.LogInfo($"{entries.Count} game map icons extracted in {sw.Elapsed.TotalSeconds:F0} s");
            }
            catch (Exception e) { log.LogWarning("map icons: extraction failed: " + e.Message); }
        }
    }
}
