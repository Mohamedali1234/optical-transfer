function finish(payload: Uint8Array, hashOk: boolean, seconds: number, totalLen: number) {
  done = true;
  captureGen++;
  stream?.getTracks().forEach((t) => t.stop());
  preview.style.display = "none";
  bar.style.width = "100%";
  const kb = Math.round(totalLen / 1024);
  const rate = (totalLen / 1024 / seconds).toFixed(1);
  stats.textContent = `${kb} KB in ${seconds.toFixed(1)} s · ${rate} KB/s · hash ${hashOk ? "verified ✓" : "MISMATCH ✗"}`;
  
  const heading = document.createElement("div");
  heading.className = "done";
  heading.textContent = "Transfer Complete!";
  
  // Create a proper File object from the payload Blob for native mobile sharing
  const blob = new Blob([payload as BlobPart]);
  const file = new File([blob], currentFileName, { type: "application/octet-stream" });

  const saveButton = document.createElement("button");
  saveButton.className = "download-btn";
  saveButton.textContent = `Save / Share ${currentFileName}`;
  saveButton.style.display = "inline-block";
  saveButton.style.marginTop = "15px";
  saveButton.style.padding = "12px 24px";
  saveButton.style.background = "#2563eb";
  saveButton.style.color = "#ffffff";
  saveButton.style.border = "none";
  saveButton.style.borderRadius = "8px";
  saveButton.style.fontWeight = "bold";
  saveButton.style.cursor = "pointer";

  saveButton.onclick = async () => {
    // Try using native mobile share sheet (triggers Android save/share dialog)
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({
          files: [file],
          title: 'Received File',
          text: `Here is your received file: ${currentFileName}`,
        });
        return;
      } catch (err) {
        if ((err as Error).name !== 'AbortError') {
          console.error('Share failed:', err);
        }
      }
    }

    // Fallback for browsers / desktop
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = currentFileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  result.append(heading, saveButton);
  
  // Automatically pop open the save/share sheet when complete
  saveButton.click();
}
