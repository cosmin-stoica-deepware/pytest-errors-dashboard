#!/usr/bin/env python3
import json
import os
import threading
import tkinter as tk
from tkinter import ttk, messagebox
import urllib.request
import urllib.error
from datetime import datetime

CONFIG_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".gui_config.json")

OUTCOMES = ["failed", "error", "passed", "skipped"]
CATEGORIES = ["", "can_timeout", "ramp_timeout", "timeout_generic"]


def load_config():
    if os.path.exists(CONFIG_PATH):
        try:
            with open(CONFIG_PATH, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            return {}
    return {}


def save_config(data):
    try:
        with open(CONFIG_PATH, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2)
    except Exception:
        pass


class App(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title("Send test result to dashboard")
        self.geometry("580x700")
        self.resizable(False, False)

        cfg = load_config()
        pad = {"padx": 10, "pady": 5}

        frame = ttk.Frame(self)
        frame.pack(fill="both", expand=True, padx=10, pady=10)

        row = 0
        ttk.Label(frame, text="Dashboard URL (endpoint /api/results)").grid(row=row, column=0, sticky="w", **pad)
        row += 1
        self.url_var = tk.StringVar(value=cfg.get("url", "https://pytest-errors-dashboard.vercel.app/api/results"))
        ttk.Entry(frame, textvariable=self.url_var, width=64).grid(row=row, column=0, columnspan=2, sticky="we", **pad)
        row += 1

        ttk.Label(frame, text="x-api-key (INGEST_TOKEN)").grid(row=row, column=0, sticky="w", **pad)
        row += 1
        key_row = ttk.Frame(frame)
        key_row.grid(row=row, column=0, columnspan=2, sticky="we")
        self.key_var = tk.StringVar(value=cfg.get("api_key", ""))
        self.key_entry = ttk.Entry(key_row, textvariable=self.key_var, width=50, show="*")
        self.key_entry.pack(side="left", padx=(10, 4))
        self.show_key_var = tk.BooleanVar(value=False)
        ttk.Checkbutton(key_row, text="show", variable=self.show_key_var, command=self.toggle_key_visibility).pack(side="left")
        row += 1

        self.remember_var = tk.BooleanVar(value=cfg.get("remember_key", True))
        ttk.Checkbutton(frame, text="remember token on this computer", variable=self.remember_var).grid(
            row=row, column=0, columnspan=2, sticky="w", **pad
        )
        row += 1

        ttk.Separator(frame).grid(row=row, column=0, columnspan=2, sticky="we", pady=8)
        row += 1

        ttk.Label(frame, text="Test name (test_name)").grid(row=row, column=0, sticky="w", **pad)
        row += 1
        self.test_name_var = tk.StringVar(value="test_example")
        ttk.Entry(frame, textvariable=self.test_name_var, width=64).grid(row=row, column=0, columnspan=2, sticky="we", **pad)
        row += 1

        ttk.Label(frame, text="Outcome").grid(row=row, column=0, sticky="w", **pad)
        row += 1
        self.outcome_var = tk.StringVar(value="failed")
        ttk.Combobox(frame, textvariable=self.outcome_var, values=OUTCOMES, state="readonly", width=20).grid(
            row=row, column=0, sticky="w", **pad
        )
        row += 1

        ttk.Label(frame, text="Build number (build_number)").grid(row=row, column=0, sticky="w", **pad)
        row += 1
        self.build_var = tk.StringVar(value="1")
        ttk.Entry(frame, textvariable=self.build_var, width=20).grid(row=row, column=0, sticky="w", **pad)
        row += 1

        ttk.Label(frame, text="Build URL (build_url, optional)").grid(row=row, column=0, sticky="w", **pad)
        row += 1
        self.build_url_var = tk.StringVar(value="")
        ttk.Entry(frame, textvariable=self.build_url_var, width=64).grid(row=row, column=0, columnspan=2, sticky="we", **pad)
        row += 1

        ttk.Label(frame, text="Jenkins node (node_name, optional)").grid(row=row, column=0, sticky="w", **pad)
        row += 1
        self.node_var = tk.StringVar(value="")
        ttk.Entry(frame, textvariable=self.node_var, width=30).grid(row=row, column=0, sticky="w", **pad)
        row += 1

        ttk.Label(frame, text="Job (job_name, optional)").grid(row=row, column=0, sticky="w", **pad)
        row += 1
        self.job_var = tk.StringVar(value="")
        ttk.Entry(frame, textvariable=self.job_var, width=30).grid(row=row, column=0, sticky="w", **pad)
        row += 1

        ttk.Label(frame, text="Category (category, optional)").grid(row=row, column=0, sticky="w", **pad)
        row += 1
        self.category_var = tk.StringVar(value="")
        ttk.Combobox(frame, textvariable=self.category_var, values=CATEGORIES, width=20).grid(row=row, column=0, sticky="w", **pad)
        row += 1

        ttk.Label(frame, text="Message / log (message, optional)").grid(row=row, column=0, sticky="w", **pad)
        row += 1
        self.message_text = tk.Text(frame, height=4, width=64)
        self.message_text.grid(row=row, column=0, columnspan=2, sticky="we", **pad)
        row += 1

        self.send_btn = ttk.Button(frame, text="Send", command=self.on_send)
        self.send_btn.grid(row=row, column=0, sticky="w", **pad)
        row += 1

        ttk.Label(frame, text="Response").grid(row=row, column=0, sticky="w", **pad)
        row += 1
        self.output = tk.Text(frame, height=8, width=70, state="disabled", bg="#111111", fg="#33ff33")
        self.output.grid(row=row, column=0, columnspan=2, sticky="we", **pad)

        self.toggle_key_visibility()

    def toggle_key_visibility(self):
        self.key_entry.config(show="" if self.show_key_var.get() else "*")

    def log(self, text):
        self.output.config(state="normal")
        timestamp = datetime.now().strftime("%H:%M:%S")
        self.output.insert("end", f"[{timestamp}] {text}\n")
        self.output.see("end")
        self.output.config(state="disabled")

    def on_send(self):
        url = self.url_var.get().strip()
        api_key = self.key_var.get().strip()
        test_name = self.test_name_var.get().strip()

        if not url:
            messagebox.showerror("Error", "Enter the dashboard URL.")
            return
        if not api_key:
            messagebox.showerror("Error", "Enter the x-api-key token.")
            return
        if not test_name:
            messagebox.showerror("Error", "Enter the test name.")
            return

        save_config({
            "url": url,
            "api_key": api_key if self.remember_var.get() else "",
            "remember_key": self.remember_var.get(),
        })

        payload = {
            "results": [{
                "test_name": test_name,
                "outcome": self.outcome_var.get(),
                "build_number": self.build_var.get().strip() or None,
                "build_url": self.build_url_var.get().strip() or None,
                "node_name": self.node_var.get().strip() or None,
                "job_name": self.job_var.get().strip() or None,
                "category": self.category_var.get().strip() or None,
                "message": self.message_text.get("1.0", "end").strip() or None,
            }]
        }

        self.send_btn.config(state="disabled")
        self.log(f"Sending to {url} ...")
        threading.Thread(target=self._send_request, args=(url, api_key, payload), daemon=True).start()

    def _send_request(self, url, api_key, payload):
        try:
            data = json.dumps(payload).encode("utf-8")
            req = urllib.request.Request(
                url,
                data=data,
                method="POST",
                headers={"Content-Type": "application/json", "x-api-key": api_key},
            )
            with urllib.request.urlopen(req, timeout=15) as resp:
                body = resp.read().decode("utf-8")
                self.after(0, self.log, f"OK ({resp.status}): {body}")
        except urllib.error.HTTPError as e:
            body = e.read().decode("utf-8", errors="replace")
            self.after(0, self.log, f"HTTP error {e.code}: {body}")
        except urllib.error.URLError as e:
            self.after(0, self.log, f"Network error: {e.reason}")
        except Exception as e:
            self.after(0, self.log, f"Unexpected error: {e}")
        finally:
            self.after(0, lambda: self.send_btn.config(state="normal"))


if __name__ == "__main__":
    App().mainloop()
