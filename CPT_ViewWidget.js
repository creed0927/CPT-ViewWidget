// Every 60 seconds, tell DataTables to re-fetch its data
setInterval(() => {
    if (window.jQuery) {
        try {
            const dt = window.jQuery('#cptsLoadInProgress').DataTable();
            dt.ajax.reload(null, false); // false = stay on current page
        } catch(e) {}
    }
}, 60000);
