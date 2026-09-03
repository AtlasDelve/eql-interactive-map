#!/usr/bin/env python3
"""One-off migration of published hubs and connector ends to authored zone-local anchors."""
import argparse
import json
import math
import os
import sys


REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(REPO, "scripts"))
import build  # noqa: E402
import mapgeom  # noqa: E402


ANCHOR_THRESH = 1200

RULED_HOSTS = {
    ("Antonica", "hubs", 6, None): "nro",
    ("Antonica", "connectors", 0, "b"): "runnyeye",
    ("Velious", "connectors", 7, "a"): "frozenshadow",
}


def rnd4(value):
    """Match the template's Math.round(v*1e4)/1e4, including negative ties."""
    out = math.floor(value * 10000 + 0.5) / 10000
    return 0 if out == 0 else out


def point_of_end(end):
    return end if isinstance(end, list) else end["xy"]


def classify(zones, point, ruled_host=None):
    distances = sorted(
        ((mapgeom.dist_to_zone(zone, point[0], point[1]), key)
         for key, zone in zones.items()),
        key=lambda item: (item[0], item[1]))
    if ruled_host is not None:
        chosen = next(item for item in distances if item[1] == ruled_host)
        alternative = next((item for item in distances if item[1] != ruled_host),
                           (float("inf"), None))
        return "ruled", chosen, alternative
    nearest, second = distances[0], distances[1] if len(distances) > 1 else (float("inf"), None)
    ambiguous = (second[0] <= nearest[0] * 1.1 or
                 (nearest[0] < 500 and second[0] <= nearest[0] + 50))
    if nearest[0] > ANCHOR_THRESH:
        state = "free"
    elif ambiguous:
        state = "ambiguous"
    else:
        state = "anchored"
    return state, nearest, second


def anchored_point(zones, point, host):
    lx, ly = mapgeom.tinv(zones[host], point[0], point[1])
    return host, rnd4(lx), rnd4(ly)


def migrate(data):
    manifest = build.load_manifest(data)
    pack_name = os.path.basename(os.path.normpath(manifest["pack"]))
    skipped = {cont: entry.get("skippedZones", [])
               for cont, entry in manifest["continents"].items()
               if entry.get("skippedZones")}
    if pack_name.casefold() != "brewall" or skipped:
        raise SystemExit("migration requires a complete Brewall cache; pack=%r skipped=%r"
                         % (manifest["pack"], skipped))

    all_data = build.build(data, "brewall")[0]
    world = build.load(os.path.join(data, "world.json"))
    proposed, report, problems = [], [], []
    for cont in world["order"]:
        path = os.path.join(build.cont_dir(cont, data), "layout.json")
        layout = build.load(path)
        original = json.dumps(layout, sort_keys=True, separators=(",", ":"))
        zones = all_data[cont]["zones"]

        for index, hub in enumerate(layout.get("hubs", [])):
            point = [hub["x"], hub["y"]]
            ruled_host = RULED_HOSTS.get((cont, "hubs", index, None))
            state, nearest, second = classify(zones, point, ruled_host)
            line = ("%s hubs[%d] state=%s host=%s dist=%.3f second=%s second_dist=%.3f"
                    % (cont, index, state, nearest[1], nearest[0], second[1], second[0]))
            report.append(line)
            if state not in ("anchored", "ruled"):
                problems.append(line)
                continue
            host, lx, ly = anchored_point(zones, point, nearest[1])
            migrated = {"x": hub["x"], "y": hub["y"], "anchor": host,
                        "lx": lx, "ly": ly}
            migrated.update({key: value for key, value in hub.items()
                             if key not in ("x", "y", "anchor", "lx", "ly")})
            layout["hubs"][index] = migrated

        for index, connector in enumerate(layout.get("connectors", [])):
            for which in ("a", "b"):
                point = point_of_end(connector[which])
                ruled_host = RULED_HOSTS.get((cont, "connectors", index, which))
                state, nearest, second = classify(zones, point, ruled_host)
                line = ("%s connectors[%d].%s state=%s host=%s dist=%.3f second=%s second_dist=%.3f"
                        % (cont, index, which, state, nearest[1], nearest[0],
                           second[1], second[0]))
                report.append(line)
                if state not in ("anchored", "ruled"):
                    problems.append(line)
                    continue
                host, lx, ly = anchored_point(zones, point, nearest[1])
                connector[which] = {"xy": point, "anchor": host, "lx": lx, "ly": ly}
        if json.dumps(layout, sort_keys=True, separators=(",", ":")) != original:
            proposed.append((path, layout))

    for line in report:
        print(line)
    print("SUMMARY anchored=%d free_or_ambiguous=%d" %
          (len(report) - len(problems), len(problems)))
    if problems:
        raise SystemExit("migration stopped without writing: free or ambiguous attachment(s) require a ruling")

    for path, layout in proposed:
        with open(path, "w", encoding="utf-8", newline="") as f:
            json.dump(layout, f, indent=2, ensure_ascii=False)
            f.write("\n")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data", default=os.path.join(REPO, "data"))
    args = parser.parse_args()
    migrate(os.path.abspath(args.data))


if __name__ == "__main__":
    main()
