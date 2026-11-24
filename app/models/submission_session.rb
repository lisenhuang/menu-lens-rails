class SubmissionSession < ApplicationRecord
  self.table_name = "sessions"
  def info = JSON.parse(details)
  def self.valid = where("expires > ?", Store.now)
end
