using System;
using System.Linq;
using UnityEngine;

namespace WebMap.World
{
    // The game's own map icons (spawn stones, boss altars, traders, pin types) for the web map.
    // Step one: find out what a dedicated server has of them (it runs without graphics).
    internal static class MapIcons
    {
        private static readonly BepInEx.Logging.ManualLogSource log = BepInEx.Logging.Logger.CreateLogSource("WebMap.icons");

        public static void Probe()
        {
            try
            {
                var mm = Minimap.instance ?? Resources.FindObjectsOfTypeAll<Minimap>().FirstOrDefault();
                log.LogInfo($"graphics device: {SystemInfo.graphicsDeviceType}; minimap: {(mm == null ? "none" : mm.name)}");
                if (mm == null) return;
                foreach (var l in mm.m_locationIcons) log.LogInfo("location " + l.m_name + ": " + Describe(l.m_icon));
                foreach (var i in mm.m_icons) log.LogInfo("pin " + i.m_name + ": " + Describe(i.m_icon));
            }
            catch (Exception e) { log.LogWarning("probe failed: " + e); }
        }

        private static string Describe(Sprite s)
        {
            if (s == null) return "no sprite";
            var t = s.texture;
            return $"sprite '{s.name}' rect {s.textureRect} texture '{(t ? t.name : "none")}' {(t ? t.width + "x" + t.height : "")} readable {(t ? t.isReadable : false)} format {(t ? t.format.ToString() : "")}";
        }
    }
}
