using System;
using System.Collections.Generic;
using System.IO;
using UnityEngine;
using WebMap.Util;

namespace WebMap.World
{
    // Points of interest as marker sets: portals with their tags, tombstones,
    // player bases, boats and carts, boss altars on explored ground, and custom
    // markers from markers.json beside the world's map data. Boss altars and the traders show
    // once someone has explored the ground they stand on; other world locations (dungeons...)
    // are not published: the game's registry knows every location whether or not anyone found
    // it, and that is a spoiler.
    internal static class Markers
    {
        private struct Portal { public float x, y, z; public string tag; }
        private struct Tomb { public float x, y, z; public string owner; public long when; }

        private static List<Portal> portals = new List<Portal>();
        private static List<Tomb> tombs = new List<Tomb>();
        private static List<Portal> buildingPortals;
        private static List<Tomb> buildingTombs;

        private static volatile string json = "{\"sets\":[]}";
        private static int rev;
        private static string customCache;
        private static DateTime customStamp;

        private static int hashPortalTag = "tag".GetStableHashCode();
        private static int hashOwnerName = "ownerName".GetStableHashCode();
        private static int hashTimeOfDeath = "timeOfDeath".GetStableHashCode();

        public static string Json => json;
        public static int Rev => rev;

        // ---- base overrides: people rename or hide the auto-detected bases from the web page.
        // Kept in bases.json beside the world's map data, matched to a detected base by distance
        // (a base's centroid drifts a little as pieces come and go).
        public sealed class BaseOverride { public float x, z; public string label; public bool hidden; }
        private static List<BaseOverride> overrides;
        private static string overridesPath;
        private const float MATCH_RADIUS = 60f;

        // The last published markers, saved after every sweep and served straight away on the next
        // start, so portals, tombstones, bases and boss altars are there before the first sweep is.
        // Only ever what was already explored when it was saved.
        private static string cachePath;
        public static void LoadCache(string worldDataPath)
        {
            cachePath = Path.Combine(worldDataPath, "markers-cache.json");
            try { if (File.Exists(cachePath)) { string c = File.ReadAllText(cachePath); if (c.StartsWith("{")) json = c; } }
            catch (Exception e) { ZLog.LogWarning("WebMap: markers cache: " + e.Message); }
        }

        public static void LoadOverrides(string worldDataPath)
        {
            overridesPath = Path.Combine(worldDataPath, "bases.json");
            overrides = new List<BaseOverride>();
            try
            {
                if (!File.Exists(overridesPath)) return;
                var doc = JsonParser.ParseObject(File.ReadAllText(overridesPath));
                var arr = JsonParser.Arr(doc, "bases");
                if (arr == null) return;
                foreach (var o in arr)
                    if (o is Dictionary<string, object> d)
                        overrides.Add(new BaseOverride { x = (float)JsonParser.Num(d, "x"), z = (float)JsonParser.Num(d, "z"), label = JsonParser.Str(d, "label", null), hidden = JsonParser.Bool(d, "hidden") });
            }
            catch (Exception e) { ZLog.LogWarning("WebMap: bases.json not readable: " + e.Message); }
        }

        private static void SaveOverrides()
        {
            if (overridesPath == null) return;
            try
            {
                var j = new JsonWriter(512);
                j.BeginObject().Key("bases").BeginArray();
                lock (overrides)
                    foreach (var o in overrides)
                    {
                        j.BeginObject().Prop("x", o.x, 1).Prop("z", o.z, 1);
                        if (o.label != null) j.Prop("label", o.label);
                        if (o.hidden) j.Prop("hidden", true);
                        j.End();
                    }
                j.End().End();
                File.WriteAllText(overridesPath, j.ToString());
            }
            catch (Exception e) { ZLog.LogWarning("WebMap: could not save bases.json: " + e.Message); }
        }

        private static BaseOverride FindOverride(float x, float z)
        {
            if (overrides == null) return null;
            BaseOverride best = null; float bd = MATCH_RADIUS * MATCH_RADIUS;
            foreach (var o in overrides)
            {
                float d = (o.x - x) * (o.x - x) + (o.z - z) * (o.z - z);
                if (d < bd) { bd = d; best = o; }
            }
            return best;
        }

        // From the web page (any thread): rename (label != null), hide, or clear (label null, hidden false).
        // The markers are rebuilt at once so the page sees it without waiting for the next sweep.
        public static void SetBase(float x, float z, string label, bool hidden)
        {
            if (overrides == null) overrides = new List<BaseOverride>();
            lock (overrides)
            {
                var o = FindOverride(x, z);
                if (label == null && !hidden) { if (o != null) overrides.Remove(o); }
                else
                {
                    if (o == null) { o = new BaseOverride { x = x, z = z }; overrides.Add(o); }
                    o.x = x; o.z = z; o.label = label; o.hidden = hidden;
                }
            }
            SaveOverrides();
            try { json = Build(); rev++; } catch (Exception e) { ZLog.LogWarning("WebMap: markers failed: " + e.Message); }
        }

        public static int ClearOverrides()
        {
            int n = overrides?.Count ?? 0;
            overrides = new List<BaseOverride>();
            SaveOverrides();
            try { json = Build(); rev++; } catch { }
            return n;
        }

        public static void Begin()
        {
            buildingPortals = new List<Portal>(portals.Count + 8);
            buildingTombs = new List<Tomb>(tombs.Count + 8);
        }

        // Main thread. Returns true if the ZDO was a marker-worthy object.
        public static bool Observe(ZDO zdo, string prefabName, Vector3 pos)
        {
            if (buildingPortals == null || prefabName == null) return false;
            string n = prefabName;
            if (n.StartsWith("portal", StringComparison.OrdinalIgnoreCase))
            {
                string tag = "";
                try { tag = zdo.GetString(hashPortalTag, "") ?? ""; } catch { }
                buildingPortals.Add(new Portal { x = pos.x, y = pos.y, z = pos.z, tag = tag });
                return true;
            }
            if (n.Equals("Player_tombstone", StringComparison.OrdinalIgnoreCase))
            {
                string owner = "";
                long when = 0;
                try { owner = zdo.GetString(hashOwnerName, "") ?? ""; } catch { }
                try { when = zdo.GetLong(hashTimeOfDeath, 0L); } catch { }
                buildingTombs.Add(new Tomb { x = pos.x, y = pos.y, z = pos.z, owner = owner, when = when });
                return true;
            }
            return false;
        }

        // Main thread, end of sweep: publish everything.
        public static void Finish()
        {
            if (buildingPortals != null) { portals = buildingPortals; tombs = buildingTombs; }
            buildingPortals = null; buildingTombs = null;
            try
            {
                string built = Build(); rev++;
                if (built != json && cachePath != null) { try { File.WriteAllText(cachePath, built); } catch { } }
                json = built;
            }
            catch (Exception e) { ZLog.LogWarning("WebMap: markers failed: " + e.Message); }
        }

        private static bool Visible(float x, float z) => WebMapConfig.REVEAL_ALL || Fog.IsExplored(x, z);

        // the boss a location prefab is the altar of, or null
        private static string BossName(string prefab)
        {
            if (string.IsNullOrEmpty(prefab)) return null;
            switch (prefab)
            {
                case "Eikthyrnir": return "Eikthyr";
                case "GDKing": return "The Elder";
                case "Bonemass": return "Bonemass";
                case "Dragonqueen": return "Moder";
                case "GoblinKing": return "Yagluth";
                case "FaderLocation": return "Fader";
            }
            return prefab.StartsWith("Mistlands_DvergrBossEntrance") ? "The Queen" : null;
        }

        // the traders' camps: name and our icon
        private static string TraderName(string prefab, out string icon)
        {
            icon = null;
            switch (prefab)
            {
                case "Vendor_BlackForest": icon = "trader"; return "Haldor";
                case "Hildir_camp": icon = "hildir"; return "Hildir";
                case "BogWitch_Camp": icon = "bogwitch"; return "Bog Witch";
            }
            return null;
        }

        // Hildir's quest dungeons, each with one of her sisters as a mini boss
        private static string MiniBossName(string prefab, out string icon)
        {
            icon = null;
            switch (prefab)
            {
                case "Hildir_crypt": icon = "hildir1"; return "Smouldering Tomb (Brenna)";
                case "Hildir_cave": icon = "hildir2"; return "Howling Cavern (Geirrhafa)";
                case "Hildir_plainsfortress": icon = "hildir3"; return "Sealed Tower (Zil & Thungr)";
            }
            return null;
        }

        // Boss altars and traders, the locations people "find" (Live.WorldEvents reports each the
        // moment its ground is explored). Main thread.
        public struct Findable { public string key, label, kind; public Vector3 pos; }
        public static List<Findable> Findables()
        {
            var list = new List<Findable>();
            var zs = ZoneSystem.instance;
            if (zs == null || zs.m_locationInstances == null) return list;
            foreach (var li in zs.m_locationInstances.Values)
            {
                string name = li.m_location?.m_prefabName;
                string label = BossName(name), kind = "boss";
                if (label == null) { label = TraderName(name, out _); kind = "trader"; }
                if (label == null) { label = MiniBossName(name, out _); kind = "miniboss"; }
                if (label == null) continue;
                list.Add(new Findable { key = name + "@" + Mathf.RoundToInt(li.m_position.x) + "," + Mathf.RoundToInt(li.m_position.z), label = label, kind = kind, pos = li.m_position });
            }
            return list;
        }

        // Main thread: publish again now (a boss altar or trader was just found), not at the next sweep
        public static void Refresh()
        {
            try
            {
                string built = Build(); rev++;
                if (built != json && cachePath != null) { try { File.WriteAllText(cachePath, built); } catch { } }
                json = built;
            }
            catch (Exception e) { ZLog.LogWarning("WebMap: markers failed: " + e.Message); }
        }

        private static string Build()
        {
            var j = new JsonWriter(8192);
            j.BeginObject();
            j.Prop("rev", rev + 1);
            j.Key("sets").BeginArray();

            // --- boss altars, once someone has explored the ground they stand on (the same rule as
            // everything here; the rest of the game's location registry stays private: spoilers)
            j.BeginObject().Prop("id", "bosses").Prop("label", "Boss altars").Key("markers").BeginArray();
            try
            {
                var zs = ZoneSystem.instance;
                if (zs != null)
                    foreach (var li in zs.m_locationInstances.Values)
                    {
                        string name = li.m_location?.m_prefabName;
                        string boss = BossName(name);
                        if (boss == null || !Visible(li.m_position.x, li.m_position.z)) continue;
                        j.BeginObject().Prop("x", li.m_position.x, 1).Prop("z", li.m_position.z, 1).Prop("y", li.m_position.y, 1)
                         .Prop("cat", "boss").Prop("icon", "boss").Prop("label", boss).Prop("prefab", name).End();
                    }
            }
            catch (Exception e) { if (WebMapConfig.DEBUG) ZLog.LogWarning("WebMap: boss altars: " + e.Message); }
            j.End().End();

            // --- mini-boss lairs (Hildir's sisters), on explored ground like the altars
            j.BeginObject().Prop("id", "minibosses").Prop("label", "Mini-boss lairs").Key("markers").BeginArray();
            try
            {
                var zs = ZoneSystem.instance;
                if (zs != null)
                    foreach (var li in zs.m_locationInstances.Values)
                    {
                        string name = li.m_location?.m_prefabName;
                        string mb = MiniBossName(name, out string icon);
                        if (mb == null || !Visible(li.m_position.x, li.m_position.z)) continue;
                        j.BeginObject().Prop("x", li.m_position.x, 1).Prop("z", li.m_position.z, 1).Prop("y", li.m_position.y, 1)
                         .Prop("cat", "miniboss").Prop("icon", icon).Prop("label", mb).Prop("prefab", name).End();
                    }
            }
            catch (Exception e) { if (WebMapConfig.DEBUG) ZLog.LogWarning("WebMap: mini bosses: " + e.Message); }
            j.End().End();

            // --- traders (Haldor, Hildir, the Bog Witch), on explored ground like the altars
            j.BeginObject().Prop("id", "traders").Prop("label", "Traders").Key("markers").BeginArray();
            try
            {
                var zs = ZoneSystem.instance;
                if (zs != null)
                    foreach (var li in zs.m_locationInstances.Values)
                    {
                        string name = li.m_location?.m_prefabName;
                        string trader = TraderName(name, out string icon);
                        if (trader == null || !Visible(li.m_position.x, li.m_position.z)) continue;
                        j.BeginObject().Prop("x", li.m_position.x, 1).Prop("z", li.m_position.z, 1).Prop("y", li.m_position.y, 1)
                         .Prop("cat", "trader").Prop("icon", icon).Prop("label", trader).Prop("prefab", name).End();
                    }
            }
            catch (Exception e) { if (WebMapConfig.DEBUG) ZLog.LogWarning("WebMap: traders: " + e.Message); }
            j.End().End();

            // --- portals
            j.BeginObject().Prop("id", "portals").Prop("label", "Portals").Key("markers").BeginArray();
            foreach (var p in portals)
            {
                if (!Visible(p.x, p.z)) continue;
                j.BeginObject().Prop("x", p.x, 1).Prop("z", p.z, 1).Prop("y", p.y, 1).Prop("cat", "portal").Prop("icon", "portal");
                j.Prop("label", string.IsNullOrEmpty(p.tag) ? "(untagged)" : p.tag).Prop("tag", p.tag).End();
            }
            j.End().End();

            // --- tombstones
            j.BeginObject().Prop("id", "tombstones").Prop("label", "Tombstones").Key("markers").BeginArray();
            foreach (var t in tombs)
            {
                if (!Visible(t.x, t.z)) continue;
                j.BeginObject().Prop("x", t.x, 1).Prop("z", t.z, 1).Prop("y", t.y, 1).Prop("cat", "tombstone").Prop("icon", "tombstone");
                j.Prop("label", string.IsNullOrEmpty(t.owner) ? "Tombstone" : t.owner + "'s tombstone").Prop("owner", t.owner).Prop("when", t.when).End();
            }
            j.End().End();

            // --- player bases (clusters of built pieces), named after a portal inside them when there is one
            j.BeginObject().Prop("id", "bases").Prop("label", "Player bases").Key("markers").BeginArray();
            try
            {
                foreach (var b in Structures.ComputeBases(WebMapConfig.BASE_MIN_PER_CELL, WebMapConfig.BASE_MIN_PIECES))
                {
                    if (!Visible(b.x, b.z)) continue;
                    var ov = FindOverride(b.x, b.z);
                    if (ov != null && ov.hidden) continue;
                    string label = ov?.label; float best = 60f * 60f;
                    if (label == null)
                        foreach (var p in portals)
                        {
                            float d = (p.x - b.x) * (p.x - b.x) + (p.z - b.z) * (p.z - b.z);
                            if (d < best && !string.IsNullOrEmpty(p.tag)) { best = d; label = p.tag; }
                        }
                    j.BeginObject().Prop("x", b.x, 1).Prop("z", b.z, 1).Prop("y", b.y, 1).Prop("cat", "base").Prop("icon", "house");
                    j.Prop("label", label != null ? label : "Base").Prop("pieces", b.pieces);
                    if (ov != null && ov.label != null) j.Prop("renamed", true);
                    j.End();
                }
            }
            catch (Exception e) { if (WebMapConfig.DEBUG) ZLog.LogWarning("WebMap: bases: " + e.Message); }
            j.End().End();

            // --- vehicles (from the same sweep)
            j.BeginObject().Prop("id", "vehicles").Prop("label", "Boats & carts").PropRaw("markers", Vehicles.GetMarkersJson()).End();

            // --- custom markers.json
            string custom = LoadCustom();
            if (custom != null) j.Raw(custom);   // one or more set objects, comma-joined

            j.End();   // sets
            j.End();
            return j.ToString();
        }

        // markers.json beside map_data/<world>/: {"sets":[{"id":"...","label":"...","markers":[{"x":0,"z":0,"label":"...","icon":"pin"}]}]}
        private static string LoadCustom()
        {
            try
            {
                string path = Path.Combine(WebMap.worldDataPath ?? "", "markers.json");
                if (!File.Exists(path)) { customCache = null; return null; }
                var stamp = File.GetLastWriteTimeUtc(path);
                if (customCache != null && stamp == customStamp) return customCache;
                var doc = JsonParser.ParseObject(File.ReadAllText(path));
                var sets = JsonParser.Arr(doc, "sets");
                if (sets == null) { customCache = null; return null; }
                bool first = true;
                var sb = new System.Text.StringBuilder();
                foreach (var so in sets)
                {
                    var set = so as Dictionary<string, object>;
                    if (set == null) continue;
                    var w = new JsonWriter(512);
                    w.BeginObject();
                    w.Prop("id", JsonParser.Str(set, "id", "custom")).Prop("label", JsonParser.Str(set, "label", "Custom"));
                    w.Key("markers").BeginArray();
                    var ms = JsonParser.Arr(set, "markers");
                    if (ms != null)
                        foreach (var mo in ms)
                        {
                            var m = mo as Dictionary<string, object>;
                            if (m == null) continue;
                            w.BeginObject();
                            w.Prop("x", JsonParser.Num(m, "x"), 1).Prop("z", JsonParser.Num(m, "z"), 1);
                            w.Prop("cat", "custom").Prop("label", JsonParser.Str(m, "label", "")).Prop("icon", JsonParser.Str(m, "icon", "pin"));
                            string desc = JsonParser.Str(m, "description", null);
                            if (desc != null) w.Prop("description", desc);
                            w.End();
                        }
                    w.End().End();
                    if (!first) sb.Append(',');
                    sb.Append(w.ToString());
                    first = false;
                }
                customCache = first ? null : sb.ToString();
                customStamp = stamp;
                return customCache;
            }
            catch (Exception e)
            {
                ZLog.LogWarning("WebMap: markers.json not understood: " + e.Message);
                customCache = null;
                return null;
            }
        }
    }
}
