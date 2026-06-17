# -*- coding: utf-8 -*-
import json
import os

path = r"C:\Users\هيثم العقلاني\.gemini\antigravity-ide\brain\343ebc27-1342-43cf-8079-932ca15a517d\.system_generated\logs\transcript.jsonl"
if not os.path.exists(path):
    print("Log file not found at " + path)
    exit(1)

with open(path, "r", encoding="utf-8") as f:
    for line in f:
        try:
            x = json.loads(line)
            if x.get("type") == "USER_INPUT":
                print(f"[{x.get('created_at')}] {x.get('content', '')}")
                print("-" * 50)
        except Exception as e:
            pass
