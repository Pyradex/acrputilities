# utils.py
# Helper utilities used by bot.py
import sqlite3
import json
import os
from typing import Optional, List, Dict, Any

DB_PATH = "acrp_tickets.db"

def init_db():
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    # Setup table for configuration
    c.execute("""
    CREATE TABLE IF NOT EXISTS setup (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        assistance_channel_id INTEGER,
        general_requests_channel_id INTEGER,
        community_requests_channel_id INTEGER,
        gsaccess TEXT,
        csaccess TEXT,
        loa_role_id INTEGER,
        ticket_logs_channel_id INTEGER,
        category_id INTEGER
    )
    """)
    # Single-row config. Insert default empty row if not present
    c.execute("SELECT COUNT(*) FROM setup")
    if c.fetchone()[0] == 0:
        c.execute("INSERT INTO setup (id) VALUES (1)")
    # Table for tickets
    c.execute("""
    CREATE TABLE IF NOT EXISTS tickets (
        channel_id INTEGER PRIMARY KEY,
        author_id INTEGER,
        type TEXT,
        description TEXT,
        claimed_by INTEGER,
        created_at INTEGER
    )
    """)
    conn.commit()
    conn.close()

def save_setup(
    assistance_channel_id: Optional[int],
    general_requests_channel_id: Optional[int],
    community_requests_channel_id: Optional[int],
    gsaccess: List[int],
    csaccess: List[int],
    loa_role_id: Optional[int],
    ticket_logs_channel_id: Optional[int],
    category_id: Optional[int]
):
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    c.execute("""
      UPDATE setup SET
        assistance_channel_id = ?,
        general_requests_channel_id = ?,
        community_requests_channel_id = ?,
        gsaccess = ?,
        csaccess = ?,
        loa_role_id = ?,
        ticket_logs_channel_id = ?,
        category_id = ?
      WHERE id = 1
    """, (
        assistance_channel_id,
        general_requests_channel_id,
        community_requests_channel_id,
        json.dumps(gsaccess),
        json.dumps(csaccess),
        loa_role_id,
        ticket_logs_channel_id,
        category_id
    ))
    conn.commit()
    conn.close()

def load_setup() -> Dict[str, Any]:
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    c.execute("SELECT assistance_channel_id, general_requests_channel_id, community_requests_channel_id, gsaccess, csaccess, loa_role_id, ticket_logs_channel_id, category_id FROM setup WHERE id = 1")
    row = c.fetchone()
    conn.close()
    if not row:
        return {}
    assistance_channel_id, gen_ch, com_ch, gs, cs, loa, logs, cat = row
    def load_list(x):
        try:
            return json.loads(x) if x else []
        except:
            return []
    return {
        "assistance_channel_id": assistance_channel_id,
        "general_requests_channel_id": gen_ch,
        "community_requests_channel_id": com_ch,
        "gsaccess": load_list(gs),
        "csaccess": load_list(cs),
        "loa_role_id": loa,
        "ticket_logs_channel_id": logs,
        "category_id": cat
    }

def create_ticket_record(channel_id: int, author_id: int, ttype: str, description: str, created_at: int):
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    c.execute("""
      INSERT OR REPLACE INTO tickets (channel_id, author_id, type, description, claimed_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    """, (channel_id, author_id, ttype, description, None, created_at))
    conn.commit()
    conn.close()

def set_ticket_claim(channel_id: int, claimer_id: int):
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    c.execute("UPDATE tickets SET claimed_by = ? WHERE channel_id = ?", (claimer_id, channel_id))
    conn.commit()
    conn.close()

def get_ticket(channel_id: int) -> Optional[Dict[str, Any]]:
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    c.execute("SELECT channel_id, author_id, type, description, claimed_by, created_at FROM tickets WHERE channel_id = ?", (channel_id,))
    row = c.fetchone()
    conn.close()
    if not row:
        return None
    channel_id, author_id, ttype, description, claimed_by, created_at = row
    return {
        "channel_id": channel_id,
        "author_id": author_id,
        "type": ttype,
        "description": description,
        "claimed_by": claimed_by,
        "created_at": created_at
    }

def clear_ticket(channel_id: int):
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    c.execute("DELETE FROM tickets WHERE channel_id = ?", (channel_id,))
    conn.commit()
    conn.close()
