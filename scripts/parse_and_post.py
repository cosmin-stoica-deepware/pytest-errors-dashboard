#!/usr/bin/env python3
import os
import sys
import json
import urllib.request
import xml.etree.ElementTree as ET

FAILURE_OUTCOMES = ("failed", "error")


def outcome_of(testcase: ET.Element) -> str:
    if testcase.find("failure") is not None:
        return "failed"
    if testcase.find("error") is not None:
        return "error"
    if testcase.find("skipped") is not None:
        return "skipped"
    return "passed"


def message_of(testcase: ET.Element):
    for tag in ("failure", "error"):
        el = testcase.find(tag)
        if el is not None:
            return (el.get("message") or el.text or "").strip()
    return None


def parse_junit(path: str):
    tree = ET.parse(path)
    root = tree.getroot()
    testcases = root.iter("testcase")

    build_url = os.environ.get("BUILD_URL")

    results = []
    for tc in testcases:
        outcome = outcome_of(tc)
        if outcome not in FAILURE_OUTCOMES:
            continue

        classname = tc.get("classname", "")
        name = tc.get("name", "")
        test_name = f"{classname}::{name}" if classname else name
        results.append({
            "test_name": test_name,
            "outcome": outcome,
            "duration": float(tc.get("time", 0) or 0),
            "build_url": build_url,
            "message": message_of(tc),
        })
    return results


def post_results(results, dashboard_url: str, token: str):
    payload = json.dumps({"results": results}).encode("utf-8")
    req = urllib.request.Request(
        dashboard_url,
        data=payload,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "x-api-key": token,
        },
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode("utf-8"))


def main():
    if len(sys.argv) < 2:
        print("Usage: parse_and_post.py <path-to-junit-report.xml>", file=sys.stderr)
        sys.exit(1)

    xml_path = sys.argv[1]
    dashboard_url = os.environ.get("DASHBOARD_URL")
    token = os.environ.get("INGEST_TOKEN")

    if not dashboard_url or not token:
        print("Error: set DASHBOARD_URL and INGEST_TOKEN as environment variables.", file=sys.stderr)
        sys.exit(1)

    results = parse_junit(xml_path)
    if not results:
        print("No failed or errored tests in this report, nothing to send.")
        return

    response = post_results(results, dashboard_url, token)
    print(f"Sent {len(results)} failures -> {response}")


if __name__ == "__main__":
    main()
