# These tests cover the supported combinational flow and reserved sequential IR.
function(engine_regression name source)
  add_executable(${name} ${source})
  target_link_libraries(${name} PRIVATE autopr simon)
  target_compile_definitions(${name} PRIVATE IFCN_TEST_SOURCE_DIR="${PROJECT_SOURCE_DIR}")
  if(MSVC)
    target_compile_options(${name} PRIVATE /UNDEBUG)
  else()
    target_compile_options(${name} PRIVATE -UNDEBUG)
  endif()
  add_test(NAME ${name} COMMAND ${name} ${ARGN})
  set_tests_properties(${name} PROPERTIES TIMEOUT 45)
endfunction()

engine_regression(simulation_metrics SimulationMetricsUnitTest.cpp)
engine_regression(mapping_io_contraction MappingIoContractionUnitTest.cpp)
engine_regression(mapping_crossover MappingCrossoverUnitTest.cpp)
engine_regression(phase_aware_routing PhaseAwareRoutingUnitTest.cpp)
engine_regression(compact_graph StochasticCompactGraphUnitTest.cpp)
engine_regression(graphviz_renderer LegacyGraphvizRendererUnitTest.cpp)
engine_regression(june_random_clock JuneRandomClockGraphUnitTest.cpp)
engine_regression(accelerated_bistable AcceleratedBistableUnitTest.cpp "${CMAKE_CURRENT_SOURCE_DIR}/fixtures/xor2.qca")
engine_regression(accelerated_coherence AcceleratedCoherenceUnitTest.cpp "${CMAKE_CURRENT_SOURCE_DIR}/fixtures/xor2.qca")
engine_regression(sequential_ir SequentialIrUnitTest.cpp)
engine_regression(sequential_global_phase SequentialGlobalPhaseSolverUnitTest.cpp)
engine_regression(physical_state_macro PhysicalStateMacroUnitTest.cpp "${CMAKE_CURRENT_BINARY_DIR}/physical_reset_toggle_macro.tex")

foreach(test_script IN ITEMS test_ifcn_agent.py test_ifcn_agent_layout_validation.py)
  get_filename_component(test_name "${test_script}" NAME_WE)
  add_test(NAME ${test_name} COMMAND "${Python3_EXECUTABLE}" "${CMAKE_CURRENT_SOURCE_DIR}/${test_script}")
  set_tests_properties(${test_name} PROPERTIES TIMEOUT 45)
endforeach()
add_test(NAME physical_benchmark_smoke COMMAND ifcn_physical_benchmark
  "${CMAKE_CURRENT_SOURCE_DIR}/fixtures/xor2.qca" --model both --repetitions 1
  --samples 128 --duration 2e-14 --time-step 1e-16
  --require-equivalent --equivalence-tolerance 0)
set_tests_properties(physical_benchmark_smoke PROPERTIES TIMEOUT 45)

if(IFCN_BUILD_PYTHON_BINDINGS)
  add_test(NAME fixed_clock_numpy_regression
    COMMAND "${Python3_EXECUTABLE}" "${CMAKE_CURRENT_SOURCE_DIR}/test_fixed_clock_layout.py")
  set_tests_properties(fixed_clock_numpy_regression PROPERTIES
    TIMEOUT 50 ENVIRONMENT "IFCN_BUILD_DIR=${CMAKE_BINARY_DIR}")
endif()
