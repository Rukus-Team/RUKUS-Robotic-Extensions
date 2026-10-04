# Step 1: Open a Controller Backup

Robot Code reads registers, positions, macros, and payloads from `.va` files
in a FANUC controller backup folder.

Register comments written inline in TP programs (e.g. `R[5:Part Count]`) are
indexed automatically and available throughout the extension.

[Add Backup Folder](command:robotCode.data.addBackupFolder)
