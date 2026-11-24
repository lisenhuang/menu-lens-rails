class Draft < ApplicationRecord
  belongs_to :submission_session, foreign_key: :owner
  def page_keys = JSON.parse(pages)
end
