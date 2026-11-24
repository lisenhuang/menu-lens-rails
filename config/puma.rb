# One process owns the resumable SQLite workers. HTTP requests use independent threads.
workers 0
threads 3, 32
bind "tcp://#{ENV.fetch('HOST','127.0.0.1')}:#{ENV.fetch('PORT','8238')}"
environment ENV.fetch("RAILS_ENV", "development")
