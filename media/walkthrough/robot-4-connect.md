# Connect a Controller

Add a FANUC controller or a ROBOGUIDE virtual controller by IP (ROBOGUIDE answers on `127.0.0.1`). Reads are **on demand** - a Get button per panel; nothing polls the robot, and a cheap heartbeat only proves it is answering.

The tutorial cell's `127.0.0.2` / `127.0.0.3` controllers are placeholders: nothing listens, so connecting to them will time out. They show the shape of a cell, not a live connection.

**You should see** the robot in the **Controllers** view, with a connection glyph in the status bar.

[Add Robot](command:robotCode.live.addRobot)
