Rails.application.config.after_initialize do
  Store.connection do |connection|
    connection.raw_connection.execute_batch(Rails.root.join("db/structure.sql").read)
  end
end
