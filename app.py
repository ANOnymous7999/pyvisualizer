"""
app.py
------
Flask backend for the Python Code Execution Visualizer.
Serves static frontend files and exposes POST /execute.
"""

from flask import Flask, request, jsonify, send_from_directory
from flask_cors import CORS
import os

from tracer import run_trace

app = Flask(__name__, static_folder=".", static_url_path="")
CORS(app)  # allow requests from the browser regardless of origin


# ── Routes ────────────────────────────────────────────────────────────────────

@app.route("/")
def index():
    return send_from_directory(".", "index.html")


@app.route("/execute", methods=["POST"])
def execute():
    """
    Accepts: { "code": "<python source>" }
    Returns: { "steps": [...], "stdout": "...", "error": null | "...", "truncated": false }
    """
    data = request.get_json(silent=True)
    if not data or "code" not in data:
        return jsonify({"error": "Missing 'code' field in request body."}), 400

    code = data["code"]

    # Basic length guard (prevent huge payloads)
    if len(code) > 8_000:
        return jsonify({"error": "Code exceeds the 8 000 character limit."}), 400

    result = run_trace(code)
    return jsonify(result)


# ── Dev server entry point ────────────────────────────────────────────────────

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    print(f"PyVisualizer running -> http://localhost:{port}")
    app.run(host="0.0.0.0", port=port, debug=True)
