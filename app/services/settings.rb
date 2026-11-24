module Settings
  MODELS = JSON.parse(Rails.root.join("config/models.json").read)
  IMAGES = MODELS.fetch("imageModels")
  READERS = MODELS.fetch("readingModels")
  module_function
  def current
    default = ENV["OPENAI_VISION_MODEL"].presence || "gpt-6.1-terra"
    base = {"model"=>ENV["OPENAI_IMAGE_MODEL"].presence || "gpt-image-2.6-sunburst", "quality"=>"high", "readingModel"=>default, "reasoning"=>"medium"}
    saved = Store.first("SELECT value FROM generation_settings WHERE id=1")
    result = base.merge(saved ? JSON.parse(saved["value"]) : {})
    result["readingModel"] = default unless READERS.key?(result["readingModel"])
    result["reasoning"] = "medium" unless READERS.dig(result["readingModel"],"efforts")&.include?(result["reasoning"])
    result
  end
  def save(body)
    value = body.slice("model","quality","reasoning","readingModel").reverse_merge("readingModel"=>current["readingModel"])
    raise Problem.new(400,"Choose a supported image model and rendering quality.") unless IMAGES.dig(value["model"],value["quality"])
    raise Problem.new(400,"Choose a supported reading model and thinking level.") unless READERS.dig(value["readingModel"],"efforts")&.include?(value["reasoning"])
    Store.sql("INSERT INTO generation_settings VALUES(1,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value",value.to_json)
    value
  end
end
