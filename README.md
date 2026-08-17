# Fleet Dashboard

A simple, friendly dashboard for keeping an eye on all the computers in your home or office, all in one place.

## What is it?

If you have a handful of computers, servers, or virtual machines scattered around, it's easy to lose track of what's running, which ones need updates, and whether everything is healthy.

**Fleet Dashboard** gathers all of that into a single, easy-to-read screen. You can see at a glance:

- Which machines are **online** and which are **offline**
- How much **memory** and **disk** each one is using
- How many **updates** are waiting
- And even open a live terminal to any machine, right from your browser

Think of it like a "mission control" view for your own little fleet of computers.

## How it looks

The dashboard shows your machines as glowing dots on a night-sky map, connected by lines. Each dot is a computer. The one in the middle is the "controller" — the machine that does the checking for you.

- **Green** = online and healthy
- **Amber** = online, but has updates waiting
- **Grey** = offline

Click any dot to see details about that machine, run its updates, or open a terminal.

## How it works (in plain words)

One computer (the "controller") quietly asks each of the others how they're doing — are they awake, how much memory is free, are there updates waiting — and shows you the answers on the dashboard. You don't have to log into each machine one by one.

## Getting started

To run this yourself, you'll need:

- A computer to act as the **controller** (it just needs to be able to reach the others)
- A way for the controller to talk to the other machines securely (the project uses **Tailscale** for this, which is free for personal use)
- The other machines set up with a username the controller can use

Then:

1. Copy the example settings file and fill in your own machine names and usernames.
2. Start the dashboard.
3. Open it in your browser and you're done.

The full setup steps live in the `backend/` folder if you want the details.

## What's inside

- **Backend** — the part that talks to your machines and collects the info
- **Frontend** — the pretty dashboard you see in your browser

## A note for the curious

This project is built with a Python backend and a React frontend. If you're technical and want the nitty-gritty, the `backend/` folder has more detail. But you don't need to know any of that to use it.

---

*Fleet Dashboard — your computers, one friendly view.*
