new WebSocket(`http://${location.hostname}:7999/ws`).onmessage = () => {
  location.reload();
};
